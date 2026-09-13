import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskEventPump } from '../src/events/pump.js';
import { RecordingBroadcaster } from '../src/events/broadcaster.js';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';
import { insertAgentInstance, insertBudget, insertTask, signInAs } from './helpers.js';

/**
 * A workspace's life after creation: archiving, leaving, deleting, and the
 * activity timestamp the list is ordered by.
 *
 * The thing worth stating about all of this, because it is what the feature is
 * for: workspace *data* was always durable -- it has been Postgres rows since
 * the first migration. What was missing was everything around that. Nothing
 * recorded when a workspace was last used, nothing could be put away, and
 * nothing could ever be removed, so the only shape a workspace's life had was
 * "exists forever from the moment somebody typed a name".
 */

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
});

async function newWorkspace(name = 'Lifecycle room') {
  const { workspaceId } = await createWorkspaceViaApi(t.app, { name });
  return workspaceId;
}

describe('archiving', () => {
  it('turns the workspace read-only for everyone, without removing anything', async () => {
    const workspaceId = await newWorkspace('Archivable');
    const taskId = await insertTask(t.handle.db, workspaceId, { title: 'Still here' });

    const archived = await t.app.inject({
      method: 'PATCH', url: `/api/workspaces/${workspaceId}/status`,
      payload: { status: 'archived' },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().status).toBe('archived');

    // Reads are untouched. That is the entire difference between archiving and
    // deleting, so it is asserted rather than assumed.
    const read = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` });
    expect(read.statusCode).toBe(200);
    const task = await t.app.inject({
      method: 'GET', url: `/api/workspaces/${workspaceId}/tasks/${taskId}` });
    expect(task.statusCode).toBe(200);

    // ...and a write is refused with a code that says why, distinct from the
    // permission codes: this caller is an owner, and would succeed the moment
    // the workspace is restored.
    const write = await t.app.inject({
      method: 'POST', url: `/api/workspaces/${workspaceId}/tasks`,
      payload: { title: 'Nope', kind: 'agent_task', creatorGuestLabel: 'Guest Cedar' },
    });
    expect(write.statusCode, write.body).toBe(409);
    expect(write.json().error.code).toBe('WORKSPACE_ARCHIVED');
  });

  it('can always be undone, including by the route that archived it', async () => {
    const workspaceId = await newWorkspace('Restorable');
    await t.app.inject({ method: 'PATCH', url: `/api/workspaces/${workspaceId}/status`,
      payload: { status: 'archived' } });

    // The archived-write rule must not swallow its own escape hatch. An archive
    // that cannot be reversed is a delete with a gentler name.
    const restored = await t.app.inject({
      method: 'PATCH', url: `/api/workspaces/${workspaceId}/status`,
      payload: { status: 'active' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().status).toBe('active');

    const write = await t.app.inject({
      method: 'POST', url: `/api/workspaces/${workspaceId}/tasks`,
      payload: { title: 'Back to work', kind: 'agent_task', creatorGuestLabel: 'Guest Cedar' },
    });
    expect(write.statusCode, write.body).toBe(201);
  });

  it('drops out of the switcher but stays in the account directory', async () => {
    const workspaceId = await newWorkspace('Put away');
    await t.app.inject({ method: 'PATCH', url: `/api/workspaces/${workspaceId}/status`,
      payload: { status: 'archived' } });

    const directory = await t.app.inject({ method: 'GET', url: '/api/auth/workspaces' });
    expect(directory.statusCode).toBe(200);
    const entry = (directory.json().workspaces as Array<{ workspaceId: string; archived: boolean }>)
      .find((item) => item.workspaceId === workspaceId);
    // Present and flagged, not filtered away: the home page needs to show it
    // under "Archived", and a list that simply loses it looks like data loss.
    expect(entry?.archived).toBe(true);
  });
});

describe('deleting', () => {
  it('refuses unless the typed name matches, and changes nothing when it does not', async () => {
    const workspaceId = await newWorkspace('Precious');
    const res = await t.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}`,
      payload: { confirmName: 'precious!' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');

    const read = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` });
    expect(read.statusCode).toBe(200);
  });

  it('removes the workspace and everything that hangs off it', async () => {
    const workspaceId = await newWorkspace('Disposable');
    const taskId = await insertTask(t.handle.db, workspaceId, { title: 'Goes with it' });

    const res = await t.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}`,
      payload: { confirmName: 'Disposable' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ workspaceId, name: 'Disposable', deletedTasks: 1 });

    const read = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` });
    expect(read.statusCode).toBe(404);
    const task = await t.handle.db.selectFrom('tasks').select('id')
      .where('id', '=', taskId).executeTakeFirst();
    expect(task).toBeUndefined();
    // The repository is Role D's and lives on disk, so the database cannot
    // remove it transactionally. The hook is how it hears about the deletion.
    expect(t.lifecycle.deleted).toContain(workspaceId);
  });

  /**
   * The case that looked like it would not work, and does.
   *
   * Deleting a workspace is one `delete from workspaces` relying on cascades,
   * and `agent_questions.answer_entry_id` is the single foreign key in the
   * schema that is not one: it references `discussion_entries` ON DELETE
   * RESTRICT, which is documented as not deferrable. The expectation was that
   * deleting a workspace where an agent question had been answered would be
   * refused, because the cited answer is being removed while a question still
   * points at it -- and that is most of the interesting workspaces.
   *
   * It is not refused. Postgres's cascade removes the `agent_questions` row,
   * through runs and agent_instances, before the RESTRICT check on the entry
   * runs. Verified directly against this schema for both `delete from
   * workspaces` and `delete from tasks`, under RESTRICT and under NO ACTION.
   *
   * The test stays because the reasoning that says it should pass is not
   * obvious, and a future change to the cascade chain should fail here rather
   * than fail a person's deletion.
   */
  it('deletes a workspace with a full run behind it: questions, answers, traces', async () => {
    const workspaceId = await newWorkspace('Answered');
    const taskId = await insertTask(t.handle.db, workspaceId, { title: 'Asked and answered' });
    const runId = randomUUID();
    await t.handle.db.insertInto('runs').values({
      id: runId, workspace_id: workspaceId, task_id: taskId, attempt: 1,
      task_version: 1, guidance_version: 1, discussion_cutoff_seq: 0,
      boot_id: randomUUID(), created_at: new Date(),
    }).execute();
    await insertBudget(t.handle.db, workspaceId, taskId, 'writer');
    const agentId = await insertAgentInstance(
      t.handle.db, workspaceId, taskId, runId, { agent_key: 'writer', preset: 'writer' });
    const question = await t.handle.db.insertInto('discussion_entries').values({
      workspace_id: workspaceId, task_id: taskId, seq: 1, actor_type: 'agent',
      body: 'Which file?', created_at: new Date(),
    }).returning('id').executeTakeFirstOrThrow();
    const answer = await t.handle.db.insertInto('discussion_entries').values({
      workspace_id: workspaceId, task_id: taskId, seq: 2, actor_type: 'guest',
      guest_label: 'Guest Cedar', body: 'documents/a.md', created_at: new Date(),
    }).returning('id').executeTakeFirstOrThrow();
    await t.handle.db.insertInto('agent_questions').values({
      workspace_id: workspaceId, task_id: taskId, run_id: runId,
      agent_instance_id: agentId, question_entry_id: question.id,
      answer_entry_id: answer.id, status: 'answered',
      asked_at: new Date(), expires_at: new Date(Date.now() + 60_000),
      resolved_at: new Date(),
    }).execute();
    // Agent histories (0013) hang off tasks and agent_instances, both of which
    // this delete reaches by cascade. Included because a table added by another
    // branch is exactly the thing that quietly turns a working delete into a
    // foreign key violation, and nothing but a test would say so.
    await t.handle.db.insertInto('agent_trace_steps').values({
      workspace_id: workspaceId, task_id: taskId, run_id: runId,
      agent_instance_id: agentId, kind: 'model_turn',
      content: { text: 'thinking about it' }, created_at: new Date(),
    }).execute();

    const res = await t.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}`,
      payload: { confirmName: 'Answered' } });
    expect(res.statusCode, res.body).toBe(200);

    // Nothing is left behind for the next person to wonder about.
    const traces = await t.handle.db.selectFrom('agent_trace_steps')
      .select('id').where('workspace_id', '=', workspaceId).execute();
    const questions = await t.handle.db.selectFrom('agent_questions')
      .select('id').where('workspace_id', '=', workspaceId).execute();
    expect([traces.length, questions.length]).toEqual([0, 0]);
  });
});

describe('leaving', () => {
  it('lets a member remove themselves without touching anyone else', async () => {
    const workspaceId = await newWorkspace('Leavable');
    const member = await signInAs(t.handle.db, { workspaceId, role: 'member', label: 'leaver' });

    const res = await t.app.inject({ method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/me`, headers: { cookie: member.cookie } });
    expect(res.statusCode, res.body).toBe(204);

    const remaining = await t.handle.db.selectFrom('workspace_members').select('user_id')
      .where('workspace_id', '=', workspaceId).execute();
    expect(remaining.map((row) => row.user_id)).toEqual([t.ownerUserId]);
  });

  it('refuses to leave a workspace with nobody else who can manage it', async () => {
    const workspaceId = await newWorkspace('Only owner');
    // The owner is the fixture account, and there is no second owner.
    const res = await t.app.inject({ method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/members/me` });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('clears a last-workspace pointer to the workspace just left', async () => {
    const workspaceId = await newWorkspace('Pointed at');
    const member = await signInAs(t.handle.db, { workspaceId, role: 'member', label: 'pointer' });
    await t.app.inject({ method: 'PATCH', url: '/api/auth/preferences',
      headers: { cookie: member.cookie }, payload: { lastWorkspace: workspaceId } });

    await t.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}/members/me`,
      headers: { cookie: member.cookie } });

    // Left behind, the pointer would send this person's next sign-in straight
    // back to the workspace they just chose to leave.
    const session = await t.app.inject({ method: 'GET', url: '/api/auth/session',
      headers: { cookie: member.cookie } });
    expect(session.json().preferences.lastWorkspace).toBeNull();
  });
});

describe('the account directory', () => {
  it('separates workspaces you belong to from ones you only opened', async () => {
    const workspaceId = await newWorkspace('Shared by link');
    const visitor = await signInAs(t.handle.db, { label: 'link-holder' });

    // A read is all it takes: opening the workspace is what records the visit.
    const read = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}`,
      headers: { cookie: visitor.cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json().access).toBe('viewer');

    const directory = await t.app.inject({ method: 'GET', url: '/api/auth/workspaces',
      headers: { cookie: visitor.cookie } });
    const body = directory.json() as {
      workspaces: Array<{ workspaceId: string }>;
      visited: Array<{ workspaceId: string }>;
    };
    // In the history, and specifically NOT in the membership list: the record
    // restores the address, never the access.
    expect(body.visited.map((item) => item.workspaceId)).toContain(workspaceId);
    expect(body.workspaces.map((item) => item.workspaceId)).not.toContain(workspaceId);
  });

  it('stops listing a workspace as visited once you are a member of it', async () => {
    const workspaceId = await newWorkspace('Joined later');
    const person = await signInAs(t.handle.db, { label: 'joiner' });
    await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}`,
      headers: { cookie: person.cookie } });
    await t.handle.db.insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: person.userId, role: 'member' }).execute();

    const directory = await t.app.inject({ method: 'GET', url: '/api/auth/workspaces',
      headers: { cookie: person.cookie } });
    const body = directory.json() as {
      workspaces: Array<{ workspaceId: string }>;
      visited: Array<{ workspaceId: string }>;
    };
    // One workspace appearing in two lists reads as two different things.
    expect(body.visited.map((item) => item.workspaceId)).not.toContain(workspaceId);
    expect(body.workspaces.map((item) => item.workspaceId)).toContain(workspaceId);
  });

  it('needs an account', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/workspaces',
      headers: { cookie: '' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('last activity', () => {
  /**
   * Ordered by activity, and activity means "something happened here" rather
   * than "the workspace record was edited". `updated_at` moves when an owner
   * renames the workspace and stays still through a week of real work, which is
   * why it was never a substitute.
   *
   * Written by the event pump, after the producing transaction has committed.
   * Doing it inside `appendEvent` would take the workspace row lock while the
   * task row lock is already held -- the opposite order from guidance edits and
   * Apply, which take workspace first and say so. Both paths read correctly
   * alone and deadlock together.
   */
  it('moves when a durable event lands, and is throttled in between', async () => {
    const workspaceId = await newWorkspace('Busy');
    const taskId = await insertTask(t.handle.db, workspaceId, { title: 'Work' });
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await t.handle.db.updateTable('workspaces').set({ last_activity_at: stale })
      .where('id', '=', workspaceId).execute();

    const pump = new TaskEventPump({
      db: t.handle.db, broadcaster: new RecordingBroadcaster(), activityThrottleMs: 60_000,
    });
    await t.handle.db.insertInto('task_events').values({
      workspace_id: workspaceId, task_id: taskId, event_key: `k-${randomUUID()}`,
      type: 'task.posted', created_at: new Date(),
    }).execute();
    await pump.flush();

    const moved = await t.handle.db.selectFrom('workspaces').select('last_activity_at')
      .where('id', '=', workspaceId).executeTakeFirstOrThrow();
    expect(new Date(moved.last_activity_at).getTime()).toBeGreaterThan(stale.getTime());

    // A second event inside the window must not rewrite the row. The throttle
    // is a WHERE clause rather than in-memory state, so it also survives the
    // restart that would make a cached "last written" value wrong.
    const settled = new Date(moved.last_activity_at).getTime();
    await t.handle.db.insertInto('task_events').values({
      workspace_id: workspaceId, task_id: taskId, event_key: `k-${randomUUID()}`,
      type: 'task.posted', created_at: new Date(),
    }).execute();
    await pump.flush();
    const again = await t.handle.db.selectFrom('workspaces').select('last_activity_at')
      .where('id', '=', workspaceId).executeTakeFirstOrThrow();
    expect(new Date(again.last_activity_at).getTime()).toBe(settled);
  });

  /**
   * The sweep must never wait on somebody else's transaction.
   *
   * Apply and guidance edits hold the workspace row for the length of their
   * transaction. A plain UPDATE here would queue behind them — inside `sweep`,
   * whose promise `stop()` awaits, so one slow transaction elsewhere becomes a
   * shutdown that hangs. `SKIP LOCKED` makes the sweep step over a locked row
   * instead.
   *
   * What is given up, stated precisely because the obvious guess is wrong: the
   * skipped row is NOT retried by the next sweep. The watermark has already
   * advanced past that event, so the timestamp moves on the next *event* in
   * that workspace, not the next sweep. For a value that orders a list in days,
   * and which is only written at all once per throttle window, that is a
   * non-cost — and a workspace whose row is locked by Apply is a workspace
   * where something is very much happening anyway.
   *
   * Mutation-checked: removing `.skipLocked()` makes this test hang rather than
   * fail, which is itself the point — the failure mode being guarded against is
   * a hang, and a hang is what the old query produced.
   */
  it('steps over a workspace row somebody else has locked, rather than waiting', async () => {
    const workspaceId = await newWorkspace('Contended');
    const taskId = await insertTask(t.handle.db, workspaceId, { title: 'Work' });
    await t.handle.db.updateTable('workspaces')
      .set({ last_activity_at: new Date(Date.now() - 60 * 60 * 1000) })
      .where('id', '=', workspaceId).execute();
    await t.handle.db.insertInto('task_events').values({
      workspace_id: workspaceId, task_id: taskId, event_key: `k-${randomUUID()}`,
      type: 'task.posted', created_at: new Date(),
    }).execute();

    const pump = new TaskEventPump({
      db: t.handle.db, broadcaster: new RecordingBroadcaster(), activityThrottleMs: 60_000,
    });

    // Hold the row exactly as Apply does -- `reviews/service.ts` takes it
    // `forNoKeyUpdate` -- and sweep while it is held.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = t.handle.db.transaction().execute(async (trx) => {
      await trx.selectFrom('workspaces').select('id')
        .where('id', '=', workspaceId).forNoKeyUpdate().executeTakeFirstOrThrow();
      await held;
    });

    try {
      // The assertion is that this resolves at all. It is awaited with a
      // deadline so a regression reports as a failure here rather than as a
      // suite that never finishes.
      const swept = await Promise.race([
        pump.flush().then(() => 'swept' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 5_000)),
      ]);
      expect(swept).toBe('swept');
    } finally {
      release();
      await holder;
    }

    // Skipped rather than written. The watermark moved past that event with
    // the broadcast, so what recovers the timestamp is the next event in this
    // workspace -- not the next sweep.
    const skipped = await t.handle.db.selectFrom('workspaces').select('last_activity_at')
      .where('id', '=', workspaceId).executeTakeFirstOrThrow();
    expect(Date.now() - new Date(skipped.last_activity_at).getTime())
      .toBeGreaterThan(30 * 60 * 1000);

    await t.handle.db.insertInto('task_events').values({
      workspace_id: workspaceId, task_id: taskId, event_key: `k-${randomUUID()}`,
      type: 'task.posted', created_at: new Date(),
    }).execute();
    await pump.flush();
    const recovered = await t.handle.db.selectFrom('workspaces').select('last_activity_at')
      .where('id', '=', workspaceId).executeTakeFirstOrThrow();
    expect(Date.now() - new Date(recovered.last_activity_at).getTime())
      .toBeLessThan(60 * 1000);
  });
});
