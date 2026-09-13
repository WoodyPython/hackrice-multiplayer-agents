import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';

/**
 * B03 acceptance (design sections 2.1 to 2.6, 11.2, 12.1).
 *
 * The two properties worth the most here:
 *   - posting is inert: no run, no agent, no hook;
 *   - Start creates exactly one attempt under both replay and true concurrency.
 */

let t: TestApp;
let workspaceId: string;

beforeAll(async () => {
  t = await buildTestApp();
  workspaceId = (await createWorkspaceViaApi(t.app, { name: 'Tasks' })).workspaceId;
});

afterAll(async () => {
  await t?.close();
});

// --- helpers ---------------------------------------------------------------

async function postTask(
  app: FastifyInstance,
  ws: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; version: number; status: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/tasks`,
    payload: { title: 'Write the FAQ', creatorGuestLabel: 'Guest Cedar', ...body },
  });
  if (res.statusCode !== 201) throw new Error(`post failed ${res.statusCode}: ${res.body}`);
  return res.json();
}

async function startTask(
  app: FastifyInstance,
  ws: string,
  taskId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/tasks/${taskId}/start`,
    payload: body,
  });
}

// ---------------------------------------------------------------------------

describe('posting is inert', () => {
  it('creates a posted task with no run and no agent', async () => {
    const before = t.orchestration.created.length;
    const task = await postTask(t.app, workspaceId, {
      outcome: 'A launch FAQ',
      criteria: ['Covers pricing', 'Covers availability'],
    });

    expect(task.status).toBe('posted');
    expect(task.version).toBe(1);

    const runs = await t.handle.db
      .selectFrom('runs')
      .select('id')
      .where('task_id', '=', task.id)
      .execute();
    expect(runs).toEqual([]);

    const agents = await t.handle.db
      .selectFrom('agent_instances')
      .select('id')
      .where('task_id', '=', task.id)
      .execute();
    expect(agents).toEqual([]);

    // Section 2.1: posting makes no Gemini request. The hook is the only path
    // to orchestration, and it must not have fired.
    expect(t.orchestration.created.length).toBe(before);
    const events = await t.handle.db
      .selectFrom('task_events')
      .selectAll()
      .where('task_id', '=', task.id)
      .execute();
    expect(events.map((e) => e.type)).toEqual(['task.posted']);
  });

  it('stores selected inputs', async () => {
    const task = await postTask(t.app, workspaceId, {
      inputs: [
        { approvedPath: 'documents/brief.md', sourceVersion: 'abc' },
        { approvedPath: 'code/api.ts' },
      ],
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
    });
    expect(res.json().inputs).toHaveLength(2);
    expect(res.json().inputs[0].approvedPath).toBe('documents/brief.md');
  });

  it('rejects an input naming more than one source', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks`,
      payload: {
        title: 'Bad input',
        creatorGuestLabel: 'Guest Cedar',
        inputs: [{ approvedPath: 'a.md', materialId: randomUUID() }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an input path that escapes the repository', async () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', '.git/config', 'a/../../b']) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/tasks`,
        payload: {
          title: 'Bad path',
          creatorGuestLabel: 'Guest Cedar',
          inputs: [{ approvedPath: bad }],
        },
      });
      expect(res.statusCode, `path ${bad} was accepted`).toBe(400);
    }
  });

  it('is idempotent on clientRequestId', async () => {
    const key = `post-${randomUUID()}`;
    const first = await postTask(t.app, workspaceId, { clientRequestId: key });
    const second = await postTask(t.app, workspaceId, { clientRequestId: key });
    expect(second.id).toBe(first.id);

    const all = await t.handle.db
      .selectFrom('tasks')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('client_request_id', '=', key)
      .execute();
    expect(all).toHaveLength(1);
  });

  it('scopes tasks to their workspace', async () => {
    const other = await createWorkspaceViaApi(t.app, { name: 'Other' });
    const task = await postTask(t.app, workspaceId);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${other.workspaceId}/tasks/${task.id}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TASK_NOT_FOUND');
  });
});

describe('revising requirements', () => {
  it('bumps the version and rejects a stale one', async () => {
    const task = await postTask(t.app, workspaceId);

    const ok = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
      payload: { expectedVersion: 1, outcome: 'Revised outcome' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(2);

    const stale = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
      payload: { expectedVersion: 1, outcome: 'Second writer' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('TASK_VERSION_CHANGED');
    // The UI rebases from this rather than guessing.
    expect(stale.json().error.details).toMatchObject({ currentVersion: 2 });
  });

  it('lets exactly one of two simultaneous saves win', async () => {
    // Section 2.1: "two form saves cannot silently overwrite each other".
    const task = await postTask(t.app, workspaceId);
    const [a, b] = await Promise.all([
      t.app.inject({
        method: 'PATCH',
        url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
        payload: { expectedVersion: 1, outcome: 'A' },
      }),
      t.app.inject({
        method: 'PATCH',
        url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
        payload: { expectedVersion: 1, outcome: 'B' },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
  });

  it('counts a change of selected inputs as a requirement change', async () => {
    // Section 2.3 lists selected inputs alongside requirements.
    const task = await postTask(t.app, workspaceId);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
      payload: { expectedVersion: 1, inputs: [{ approvedPath: 'documents/new.md' }] },
    });
    expect(res.json().version).toBe(2);
    expect(res.json().inputs).toHaveLength(1);
  });

  it('refuses to revise a completed task', async () => {
    const task = await postTask(t.app, workspaceId);
    await t.handle.db
      .updateTable('tasks')
      .set({ status: 'completed' })
      .where('id', '=', task.id)
      .execute();

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
      payload: { expectedVersion: 1, outcome: 'too late' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE');
  });
});

describe('Start', () => {
  it('creates one run and hands it to orchestration', async () => {
    const task = await postTask(t.app, workspaceId);
    const before = t.orchestration.created.length;

    const res = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ attempt: 1, taskStatus: 'planning', idempotentReplay: false });

    const handed = t.orchestration.created.slice(before);
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ workspaceId, taskId: task.id, runId: res.json().runId });
  });

  it('freezes the discussion cutoff at the run, not at dispatch', async () => {
    // Section 2.3: entries after this never enter any agent context for the run.
    const task = await postTask(t.app, workspaceId);
    for (const body of ['first', 'second']) {
      await t.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/tasks/${task.id}/discussion`,
        payload: { body, guestLabel: 'Guest Cedar' },
      });
    }

    const started = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });

    const run = await t.handle.db
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', started.json().runId)
      .executeTakeFirstOrThrow();
    expect(run.discussion_cutoff_seq).toBe(2);

    // A later comment lands above the cutoff and is labeled as such.
    await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/discussion`,
      payload: { body: 'after start', guestLabel: 'Guest Fern' },
    });

    const list = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/discussion`,
    });
    const entries = list.json().entries;
    expect(entries.map((e: { afterActiveRunCutoff: boolean }) => e.afterActiveRunCutoff)).toEqual([
      false,
      false,
      true,
    ]);
    expect(list.json().activeRunCutoffSeq).toBe(2);
  });

  it('captures the task and guidance versions at creation', async () => {
    const ws = await createWorkspaceViaApi(t.app, { name: 'Versioned' });
    await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${ws.workspaceId}`,
      headers: { 'x-owner-key': ws.ownerKey },
      payload: { guidance: 'House style' },
    });
    const task = await postTask(t.app, ws.workspaceId);

    const started = await startTask(t.app, ws.workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    const run = await t.handle.db
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', started.json().runId)
      .executeTakeFirstOrThrow();

    expect(run.task_version).toBe(1);
    expect(run.guidance_version).toBe(2);
    expect(run.boot_id).toBeTruthy();
  });

  it('returns the original run for a replayed request', async () => {
    const task = await postTask(t.app, workspaceId);
    const key = randomUUID();
    const before = t.orchestration.created.length;

    const first = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: key,
    });
    const replay = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: key,
    });

    expect(replay.json().runId).toBe(first.json().runId);
    expect(replay.json().idempotentReplay).toBe(true);
    // A replay must not re-trigger orchestration.
    expect(t.orchestration.created.length - before).toBe(1);
  });

  it('creates one attempt under genuinely concurrent requests', async () => {
    /*
     * The idempotency key cannot help here: two different keys, arriving at
     * once. This is what runs_active_uq is for.
     */
    const task = await postTask(t.app, workspaceId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        startTask(t.app, workspaceId, task.id, {
          expectedVersion: 1,
          clientRequestId: randomUUID(),
        }),
      ),
    );

    const accepted = results.filter((r) => r.statusCode === 202);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      expect(r.json().error.code).toBe('TASK_ALREADY_RUNNING');
    }

    const runs = await t.handle.db
      .selectFrom('runs')
      .select('id')
      .where('task_id', '=', task.id)
      .execute();
    expect(runs).toHaveLength(1);
  });

  it('refuses a stale version', async () => {
    const task = await postTask(t.app, workspaceId);
    await t.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}`,
      payload: { expectedVersion: 1, outcome: 'changed' },
    });

    const res = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TASK_VERSION_CHANGED');
  });

  it('points the task at its run through a constraint that cannot cross tasks', async () => {
    const task = await postTask(t.app, workspaceId);
    const started = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    const row = await t.handle.db
      .selectFrom('tasks')
      .select(['active_run_id', 'status'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(row.active_run_id).toBe(started.json().runId);
    expect(row.status).toBe('planning');
  });
});

describe('cancel', () => {
  it('stops the run, clears the pointer, and notifies orchestration', async () => {
    const task = await postTask(t.app, workspaceId);
    const started = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    const runId = started.json().runId;

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/cancel`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('canceled');
    expect(res.json().activeRunId).toBeNull();

    const run = await t.handle.db
      .selectFrom('runs')
      .select(['status', 'ended_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('canceled');
    expect(run.ended_at).toBeInstanceOf(Date);

    expect(t.orchestration.canceled.at(-1)).toMatchObject({ runId });
  });

  it('frees the active-run slot so a new attempt can start', async () => {
    const task = await postTask(t.app, workspaceId);
    await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/cancel`,
      payload: {},
    });

    const again = await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    expect(again.statusCode).toBe(202);
    expect(again.json().attempt).toBe(2);
  });

  it('refuses when nothing is running', async () => {
    const task = await postTask(t.app, workspaceId);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/cancel`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE');
  });
});

describe('retry', () => {
  it('creates a new attempt at the current version', async () => {
    const task = await postTask(t.app, workspaceId);
    await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/cancel`,
      payload: {},
    });

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/retry`,
      payload: { clientRequestId: randomUUID() },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().attempt).toBe(2);
  });

  it('never resets an existing agent budget', async () => {
    // Section 14.3: "An exhausted budget remains exhausted on retry."
    const task = await postTask(t.app, workspaceId);
    await t.handle.db
      .insertInto('task_agent_budgets')
      .values({
        workspace_id: workspaceId,
        task_id: task.id,
        agent_key: 'orchestrator',
        token_budget: 64_000,
        consumed_tokens: 64_000,
      })
      .execute();

    await startTask(t.app, workspaceId, task.id, {
      expectedVersion: 1,
      clientRequestId: randomUUID(),
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/cancel`,
      payload: {},
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${task.id}/retry`,
      payload: { clientRequestId: randomUUID() },
    });

    const budget = await t.handle.db
      .selectFrom('task_agent_budgets')
      .selectAll()
      .where('task_id', '=', task.id)
      .where('agent_key', '=', 'orchestrator')
      .executeTakeFirstOrThrow();
    expect(budget.consumed_tokens).toBe(64_000);
  });
});

describe('manual-edit tasks', () => {
  it('allows one active editing task per file', async () => {
    const ws = (await createWorkspaceViaApi(t.app, { name: 'Edits' })).workspaceId;
    await postTask(t.app, ws, {
      kind: 'manual_edit',
      manualSourcePath: 'documents/faq.md',
      title: 'Edit faq.md',
    });

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/tasks`,
      payload: {
        kind: 'manual_edit',
        manualSourcePath: 'documents/faq.md',
        title: 'Edit faq.md again',
        creatorGuestLabel: 'Guest Fern',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE');
    // Actionable: the UI can point at the file rather than showing a constraint name.
    expect(res.json().error.details.manualSourcePath).toBe('documents/faq.md');
  });

  it('frees the file once the editing task is canceled', async () => {
    const ws = (await createWorkspaceViaApi(t.app, { name: 'Edits 2' })).workspaceId;
    const first = await postTask(t.app, ws, {
      kind: 'manual_edit',
      manualSourcePath: 'documents/notes.md',
      title: 'Edit notes.md',
    });
    await t.handle.db
      .updateTable('tasks')
      .set({ status: 'canceled' })
      .where('id', '=', first.id)
      .execute();

    const second = await postTask(t.app, ws, {
      kind: 'manual_edit',
      manualSourcePath: 'documents/notes.md',
      title: 'Edit notes.md again',
    });
    expect(second.id).not.toBe(first.id);
  });

  it('refuses to restart an editing task whose file another task now owns', async () => {
    /*
     * Reachable and not covered by section 2.4 or 2.5: cancel M1, which frees
     * the path; open the file again, creating M2; then retry M1. The database
     * is right to refuse, and the caller needs to be told to open M2.
     */
    const ws = (await createWorkspaceViaApi(t.app, { name: 'Edits 3' })).workspaceId;
    const m1 = await postTask(t.app, ws, {
      kind: 'manual_edit',
      manualSourcePath: 'documents/spec.md',
      title: 'Edit spec.md',
    });
    await t.handle.db
      .updateTable('tasks')
      .set({ status: 'canceled' })
      .where('id', '=', m1.id)
      .execute();
    await postTask(t.app, ws, {
      kind: 'manual_edit',
      manualSourcePath: 'documents/spec.md',
      title: 'Edit spec.md (new owner)',
    });

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/tasks/${m1.id}/retry`,
      payload: { clientRequestId: randomUUID() },
    });
    expect(res.statusCode).toBe(409);
  });

  it('requires manualSourcePath exactly for manual_edit', async () => {
    const missing = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks`,
      payload: { kind: 'manual_edit', title: 'No path', creatorGuestLabel: 'Guest Cedar' },
    });
    expect(missing.statusCode).toBe(400);

    const extra = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks`,
      payload: {
        kind: 'agent_task',
        manualSourcePath: 'documents/x.md',
        title: 'Path on agent task',
        creatorGuestLabel: 'Guest Cedar',
      },
    });
    expect(extra.statusCode).toBe(400);
  });
});

describe('task list', () => {
  it('summarises open questions and attachments for the board', async () => {
    const ws = (await createWorkspaceViaApi(t.app, { name: 'Board' })).workspaceId;
    await postTask(t.app, ws, { title: 'One' });
    await postTask(t.app, ws, { title: 'Two' });

    const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/tasks` });
    expect(res.statusCode).toBe(200);
    const tasks = res.json().tasks;
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task).toMatchObject({ materialCount: 0, openQuestionCount: 0 });
      expect(typeof task.creatorGuestLabel).toBe('string');
    }
  });

  it('filters by status', async () => {
    const ws = (await createWorkspaceViaApi(t.app, { name: 'Filter' })).workspaceId;
    const a = await postTask(t.app, ws, { title: 'Posted one' });
    await startTask(t.app, ws, a.id, { expectedVersion: 1, clientRequestId: randomUUID() });
    await postTask(t.app, ws, { title: 'Still posted' });

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/tasks?status=posted`,
    });
    expect(res.json().tasks).toHaveLength(1);
    expect(res.json().tasks[0].title).toBe('Still posted');
  });
});


describe('completion and reruns', () => {
  it.each(['posted', 'ready_for_review', 'awaiting_confirmation', 'incomplete', 'canceled'] as const)('lets anyone complete and restore %s tasks', async (initialStatus) => {
    const ws = await createWorkspaceViaApi(t.app);
    const task = await postTask(t.app, ws.workspaceId);
    await t.handle.db.updateTable('tasks').set({ status: initialStatus }).where('id', '=', task.id).execute();
    const url = `/api/workspaces/${ws.workspaceId}/tasks/${task.id}/status`;
    const move = (expectedStatus: string, status: string) => t.app.inject({
      method: 'PATCH', url, payload: { expectedStatus, status },
    });
    const completed = await move(initialStatus, 'completed');
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().status).toBe('completed');
    expect((await move(initialStatus, 'completed')).statusCode).toBe(409);
    const restored = await move('completed', 'unmark');
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().status).toBe(initialStatus);
    expect((await move(initialStatus, 'unmark')).statusCode).toBe(409);
    expect((await move(initialStatus, 'posted')).statusCode).toBe(403);
  });

  it('refuses to complete a running task', async () => {
    const task = await postTask(t.app, workspaceId);
    await startTask(t.app, workspaceId, task.id, { expectedVersion: task.version, clientRequestId: randomUUID() });
    const response = await t.app.inject({ method: 'PATCH', url: `/api/workspaces/${workspaceId}/tasks/${task.id}/status`,
      payload: { expectedStatus: 'planning', status: 'completed' } });
    expect(response.statusCode).toBe(409);
  });

  it.each(['completed', 'ready_for_review', 'awaiting_confirmation'] as const)('reruns and stops %s work', async (status) => {
    const task = await postTask(t.app, workspaceId);
    await t.handle.db.updateTable('tasks').set({ status }).where('id', '=', task.id).execute();
    const response = await startTask(t.app, workspaceId, task.id, { expectedVersion: task.version, clientRequestId: randomUUID() });
    expect(response.statusCode, response.body).toBe(202);
    const stop = await t.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${task.id}/cancel`, payload: {} });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json().status).toBe('canceled');
  });
});
