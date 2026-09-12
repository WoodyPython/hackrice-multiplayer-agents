import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentPlan } from '@app/contracts';
import { PgAgentLedger } from '../src/agents/ledger.js';
import { PgRunStore, assertAcyclic } from '../src/runs/run-store.js';
import { PgReviewStore } from '../src/runs/review-store.js';
import { BOOT_ID, fakeSha } from './helpers.js';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';

/**
 * B07 acceptance (design sections 8.3, 10.1, 10.3, 10.5, 11.2, 14.4).
 *
 * Token accounting and agent lifecycle are covered by agents.test.ts, against
 * PgAgentLedger. There is one ledger and one instance-creation path, so these
 * fixtures use it too rather than inserting rows directly — a test that builds
 * state a different way from production is a test of the fixture.
 */

let t: TestApp;
let ledger: PgAgentLedger;
let runs: PgRunStore;
let reviews: PgReviewStore;
let workspaceId: string;

beforeAll(async () => {
  t = await buildTestApp();
  ledger = new PgAgentLedger({ db: t.handle.db, bootId: BOOT_ID });
  runs = new PgRunStore({ db: t.handle.db, bootId: BOOT_ID });
  reviews = new PgReviewStore({ db: t.handle.db });
  workspaceId = (await createWorkspaceViaApi(t.app, { name: 'Runs' })).workspaceId;
});

afterAll(async () => {
  await t?.close();
});

// --- fixtures --------------------------------------------------------------

async function makeTask(title = 'Run task'): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/tasks`,
    payload: { title, creatorGuestLabel: 'Guest Cedar' },
  });
  return res.json().id;
}

/** A run that is active and pointed at by its task, as Start leaves it. */
async function makeRun(taskId: string, attempt = 1): Promise<string> {
  const row = await t.handle.db
    .insertInto('runs')
    .values({
      workspace_id: workspaceId,
      task_id: taskId,
      attempt,
      task_version: 1,
      guidance_version: 1,
      discussion_cutoff_seq: 0,
      boot_id: BOOT_ID,
      status: 'working',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await t.handle.db
    .updateTable('tasks')
    .set({ status: 'working', active_run_id: row.id })
    .where('id', '=', taskId)
    .execute();
  return row.id;
}

const PLAN: AgentPlan = {
  summary: 'Produce a launch FAQ and announcement from the supplied brief.',
  assignments: [
    { id: 'facts', preset: 'analyst', dependsOn: [], writePaths: [], instruction: 'Extract facts.' },
    { id: 'faq', preset: 'writer', dependsOn: ['facts'], writePaths: ['documents/faq.md'], instruction: 'Draft the FAQ.' },
    { id: 'announce', preset: 'writer', dependsOn: ['facts'], writePaths: ['documents/announce.md'], instruction: 'Draft the announcement.' },
    { id: 'review', preset: 'reviewer', dependsOn: ['faq', 'announce'], writePaths: [], instruction: 'Check coverage.' },
  ],
};

async function materialise(runId: string, plan: AgentPlan = PLAN) {
  const created = [];
  for (const assignment of plan.assignments) {
    created.push(
      await ledger.createInstance({
        runId,
        agentKey: assignment.id,
        assignmentKey: assignment.id,
        preset: assignment.preset,
        modelId: 'gemini-2.5-flash',
        instruction: assignment.instruction,
        writePaths: assignment.writePaths,
      }),
    );
  }
  await runs.linkDependencies(runId, plan);
  return created;
}

// ---------------------------------------------------------------------------

describe('plan validation', () => {
  it('accepts the design section 8.3 example shape', () => {
    expect(() => assertAcyclic(PLAN)).not.toThrow();
  });

  it('rejects a cycle and names it', () => {
    // Section 11.2: "Do not rely only on foreign keys to prevent cycles."
    const cyclic: AgentPlan = {
      summary: 'cyclic',
      assignments: [
        { id: 'a', preset: 'writer', dependsOn: ['c'], writePaths: [], instruction: 'x' },
        { id: 'b', preset: 'writer', dependsOn: ['a'], writePaths: [], instruction: 'x' },
        { id: 'c', preset: 'writer', dependsOn: ['b'], writePaths: [], instruction: 'x' },
      ],
    };
    expect(() => assertAcyclic(cyclic)).toThrowError(/cycle/i);
  });

  it('rejects a self-dependency', () => {
    const selfDep: AgentPlan = {
      summary: 'self',
      assignments: [
        { id: 'a', preset: 'writer', dependsOn: ['a'], writePaths: [], instruction: 'x' },
      ],
    };
    expect(() => assertAcyclic(selfDep)).toThrowError(/cycle/i);
  });

  it('rejects a dependency on an assignment that does not exist', () => {
    const dangling: AgentPlan = {
      summary: 'dangling',
      assignments: [
        { id: 'a', preset: 'writer', dependsOn: ['ghost'], writePaths: [], instruction: 'x' },
      ],
    };
    expect(() => assertAcyclic(dangling)).toThrowError(/not in the plan/i);
  });
});

describe('the assignment graph', () => {
  it('links dependencies between the instances of one run', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    await materialise(runId);

    const instances = await runs.listInstances(runId);
    const faq = instances.find((a) => a.assignmentKey === 'faq')!;
    const facts = instances.find((a) => a.assignmentKey === 'facts')!;
    const review = instances.find((a) => a.assignmentKey === 'review')!;

    expect(facts.dependsOn).toEqual([]);
    expect(faq.dependsOn).toEqual([facts.id]);
    expect(review.dependsOn).toHaveLength(2);
  });

  it('refuses to link a plan whose instances were never created', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    await expect(runs.linkDependencies(runId, PLAN)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('is idempotent, so a retried link does not duplicate edges', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    await materialise(runId);
    await runs.linkDependencies(runId, PLAN);

    const edges = await t.handle.db
      .selectFrom('agent_dependencies')
      .select('agent_id')
      .where('run_id', '=', runId)
      .execute();
    expect(edges).toHaveLength(4);
  });

  it('reports only assignments whose prerequisites have completed', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const created = await materialise(runId);

    // Only the root is ready.
    let ready = await runs.readyInstances(runId);
    expect(ready.map((a) => a.assignmentKey)).toEqual(['facts']);

    // Completing it releases both writers at once — section 8.7's parallelism.
    const facts = created.find((a) => a.assignment_key === 'facts')!;
    await t.handle.db
      .updateTable('agent_instances')
      .set({ status: 'completed', ended_at: new Date() })
      .where('id', '=', facts.id)
      .execute();

    ready = await runs.readyInstances(runId);
    expect(ready.map((a) => a.assignmentKey).sort()).toEqual(['announce', 'faq']);
  });
});

describe('the database refuses late writes from terminal instances', () => {
  /*
   * Migration 0006. Section 11.2 asks for this at the database level, and the
   * asymmetry with task transitions is the point: an agent write can arrive
   * from a detached async context with no request holding a lock. Section 9.2:
   * "canceling a local request does not guarantee the provider stopped."
   *
   * Driven through raw updates rather than a service, because the guarantee
   * under test is that the database refuses regardless of which code path asks.
   */
  async function terminalAgent(): Promise<string> {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agent = await ledger.createInstance({
      runId,
      agentKey: 'writer',
      assignmentKey: 'writer',
      preset: 'writer',
      modelId: 'gemini-2.5-flash',
    });
    await t.handle.db
      .updateTable('agent_instances')
      .set({ status: 'timed_out', ended_at: new Date() })
      .where('id', '=', agent.id)
      .execute();
    return agent.id;
  }

  it('rejects a result written after the agent timed out', async () => {
    const agentId = await terminalAgent();
    await expect(
      t.handle.db
        .updateTable('agent_instances')
        .set({ result_sha: fakeSha('late') })
        .where('id', '=', agentId)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'agent_instances_terminal_no_write' });
  });

  it('rejects a transition out of a terminal status', async () => {
    const agentId = await terminalAgent();
    await expect(
      t.handle.db
        .updateTable('agent_instances')
        .set({ status: 'completed' })
        .where('id', '=', agentId)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'agent_instances_terminal_no_transition' });
  });

  it('rejects extending the deadline of a terminal instance', async () => {
    const agentId = await terminalAgent();
    await expect(
      t.handle.db
        .updateTable('agent_instances')
        .set({ deadline_at: new Date(Date.now() + 600_000) })
        .where('id', '=', agentId)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'agent_instances_terminal_no_write' });
  });

  it('still allows late usage to be recorded', async () => {
    // Section 9.2: "Late usage may still be recorded; late edits are still
    // rejected." The guard must not block the first half of that.
    const agentId = await terminalAgent();
    await expect(
      t.handle.db
        .updateTable('model_calls')
        .set({ status: 'reported' })
        .where('agent_id', '=', agentId)
        .execute(),
    ).resolves.toBeDefined();
  });
});

describe('run records', () => {
  it('records the captured snapshot and manifest', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);

    await runs.recordCapture(runId, {
      inputSnapshotSha: fakeSha('snap'),
      contextManifest: {
        taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [],
        approvedPaths: [], approvedCommitSha: null, draftCheckpointSha: null,
        draftFileHashes: {},
      },
    });

    const run = await runs.read(runId);
    expect(run!.input_snapshot_sha).toBe(fakeSha('snap'));
    expect(run!.context_manifest).toMatchObject({ taskVersion: 1 });
  });

  it('frees the task when the run settles', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    await runs.settle(runId, 'incomplete', 'an agent timed out');

    const task = await t.handle.db
      .selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow();
    expect(task.active_run_id).toBeNull();
    expect((await runs.read(runId))!.status).toBe('incomplete');
  });

  it('is idempotent when the run has already settled', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    await runs.settle(runId, 'canceled');
    await runs.settle(runId, 'completed');
    expect((await runs.read(runId))!.status).toBe('canceled');
  });
});

describe('assignments for the Agents tab', () => {
  /**
   * Section 4.5. The properties that matter are what the response does NOT
   * carry as much as what it does: no instruction in full, no model ID, and no
   * invented token figures.
   */
  async function agents(taskId: string) {
    return t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/agents`,
    });
  }

  it('returns every attempt newest first, each with its own assignments', async () => {
    const taskId = await makeTask();
    const first = await makeRun(taskId, 1);
    await materialise(first);
    await runs.settle(first, 'incomplete', 'an agent timed out');
    const second = await makeRun(taskId, 2);
    await materialise(second);

    const body = (await agents(taskId)).json();
    expect(body.attempts.map((a: { attempt: number }) => a.attempt)).toEqual([2, 1]);
    // Section 4.7 requires an incomplete task to show preserved output, so a
    // retry must not make the failed attempt's assignments unreachable.
    expect(body.attempts[1].status).toBe('incomplete');
    expect(body.attempts[1].assignments).toHaveLength(4);
    expect(body.attempts[0].assignments).toHaveLength(4);
    // Assignments belong to their own run, never pooled across attempts.
    const runIds = new Set(
      body.attempts[0].assignments.map((a: { runId: string }) => a.runId),
    );
    expect([...runIds]).toEqual([second]);
  });

  it('carries the dependency graph, so parallel work can be laid out', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const created = await materialise(runId);
    // createInstance returns the raw row, so the key is snake_case here.
    const byKey = new Map(created.map((agent) => [agent.assignment_key, agent.id]));

    const attempt = (await agents(taskId)).json().attempts[0];
    const find = (key: string) =>
      attempt.assignments.find((a: { assignmentKey: string }) => a.assignmentKey === key);

    expect(find('facts').dependsOn).toEqual([]);
    expect(find('faq').dependsOn).toEqual([byKey.get('facts')]);
    // Two assignments depending on the same prerequisite and on nothing else is
    // exactly the parallelism section 4.5 asks to be made visible.
    expect(find('announce').dependsOn).toEqual([byKey.get('facts')]);
    expect(new Set(find('review').dependsOn)).toEqual(
      new Set([byKey.get('faq'), byKey.get('announce')]),
    );
  });

  it('summarises the instruction and never sends it whole', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const long = `Draft the FAQ. ${'x'.repeat(5000)}`;
    await ledger.createInstance({
      runId, agentKey: 'long', assignmentKey: 'long', preset: 'writer',
      modelId: 'gemini-2.5-flash', instruction: long, writePaths: ['documents/faq.md'],
    });

    const assignment = (await agents(taskId)).json().attempts[0].assignments[0];
    expect(assignment.instruction).toBeUndefined();
    expect(assignment.instructionSummary.length).toBeLessThanOrEqual(280);
    expect(assignment.instructionSummary.startsWith('Draft the FAQ.')).toBe(true);
    expect(assignment.instructionSummary).not.toContain('x'.repeat(300));
  });

  it('exposes no model, provider, budget, or token figure', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    await materialise(runId);

    const raw = (await agents(taskId)).body;
    // Section 4.5: "Do not expose model selection, provider settings, budget
    // settings, or timeout controls." The instances were created with a real
    // model ID, so this fails the moment the row is serialised wholesale.
    expect(raw).not.toContain('gemini');
    expect(raw).not.toContain('modelId');
    // Absent, not zero. A zero would read as a measurement rather than a
    // missing one, and the ledger has no read method yet.
    expect(raw).not.toContain('tokensConsumed');
    expect(raw).not.toContain('tokenBudget');
  });

  it('reports a task from another workspace as absent, not empty', async () => {
    const taskId = await makeTask();
    await makeRun(taskId);
    const other = (await createWorkspaceViaApi(t.app, { name: 'Elsewhere' })).workspaceId;

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${other}/tasks/${taskId}/agents`,
    });
    // Section 11.4: the workspace in the path IS the access check, and there is
    // no identity to deny, so a foreign task is 404 and never 403.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TASK_NOT_FOUND');
  });

  it('returns an empty attempt list for a task that never started', async () => {
    const taskId = await makeTask();
    const res = await agents(taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().attempts).toEqual([]);
  });
});

describe('startup reconciliation', () => {
  it('refuses late finalization of a live run owned by another boot', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const foreign = new PgRunStore({ db: t.handle.db, bootId: randomUUID() });
    await expect(foreign.settle(runId, 'completed', undefined, 'ready_for_review')).rejects.toMatchObject({ code: 'RUN_INTERRUPTED' });
    expect((await runs.read(runId))!.status).toBe('working');
    expect((await t.handle.db.selectFrom('tasks').select('active_run_id').where('id', '=', taskId).executeTakeFirst())!.active_run_id).toBe(runId);
  });

  it('marks work from a previous boot interrupted and frees the task', async () => {
    // Section 14.4 step 2.
    const taskId = await makeTask();
    const previousBoot = randomUUID();

    const run = await t.handle.db
      .insertInto('runs')
      .values({
        workspace_id: workspaceId, task_id: taskId, attempt: 1, task_version: 1,
        guidance_version: 1, discussion_cutoff_seq: 0, boot_id: previousBoot, status: 'working',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.handle.db
      .updateTable('tasks')
      .set({ status: 'working', active_run_id: run.id })
      .where('id', '=', taskId)
      .execute();
    await t.handle.db
      .insertInto('task_agent_budgets')
      .values({ workspace_id: workspaceId, task_id: taskId, agent_key: 'stranded', token_budget: 64_000 })
      .execute();
    await t.handle.db
      .insertInto('agent_instances')
      .values({
        workspace_id: workspaceId, task_id: taskId, run_id: run.id, agent_key: 'stranded',
        assignment_key: 'stranded', preset: 'writer', model_id: 'm',
        boot_id: previousBoot, status: 'running',
      })
      .execute();

    const result = await runs.markInterruptedFromPreviousBoots();
    expect(result.runs).toBeGreaterThanOrEqual(1);
    expect(result.agents).toBeGreaterThanOrEqual(1);

    const task = await t.handle.db
      .selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow();
    expect(task.status).toBe('interrupted');
    // Freeing the pointer is what makes a retry possible at all.
    expect(task.active_run_id).toBeNull();
  });

  it('leaves the current boot alone', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    await runs.markInterruptedFromPreviousBoots();

    expect((await runs.read(runId))!.status).toBe('working');
  });

  it('refuses a capture from a previous boot', async () => {
    const taskId = await makeTask();
    const previousBoot = randomUUID();
    const run = await t.handle.db
      .insertInto('runs')
      .values({
        workspace_id: workspaceId, task_id: taskId, attempt: 1, task_version: 1,
        guidance_version: 1, discussion_cutoff_seq: 0, boot_id: previousBoot, status: 'planning',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await expect(
      runs.recordCapture(run.id, {
        inputSnapshotSha: fakeSha('snap'),
        contextManifest: {
          taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [],
          approvedPaths: [], approvedCommitSha: null, draftCheckpointSha: null,
          draftFileHashes: {},
        },
      }),
    ).rejects.toMatchObject({ code: 'RUN_INTERRUPTED' });
  });
});

describe('reviews', () => {
  async function buildingReview(taskId: string) {
    return reviews.create({
      workspaceId,
      taskId,
      runId: null,
      source: {
        taskVersion: 1,
        guidanceVersion: 1,
        mainSha: fakeSha('main'),
        humanSha: fakeSha('human'),
        resultSha: null,
        documentRevisions: {},
        contextHash: 'ctx',
      },
    });
  }

  it('records the exact source tuple', async () => {
    const taskId = await makeTask();
    const review = await buildingReview(taskId);
    expect(review.status).toBe('building');
    expect(review.candidateSha).toBeNull();
    expect(review.source.mainSha).toBe(fakeSha('main'));
  });

  it('cannot be applied before it is ready', async () => {
    const taskId = await makeTask();
    const review = await buildingReview(taskId);
    await expect(
      reviews.claimForApply(review.id, fakeSha('cand')),
    ).rejects.toMatchObject({ code: 'REVIEW_STALE' });
  });

  it('goes stale on any new edit and cannot then be applied', async () => {
    // Section 7.6: a new accepted edit marks it stale immediately.
    const taskId = await makeTask();
    const review = await buildingReview(taskId);
    await reviews.markReady(review.id, fakeSha('cand'));

    expect(await reviews.invalidateForTask(taskId, 'human edit')).toBe(1);
    await expect(
      reviews.claimForApply(review.id, fakeSha('cand')),
    ).rejects.toMatchObject({ code: 'REVIEW_STALE' });
  });

  it('refuses a candidate the caller was not looking at', async () => {
    const taskId = await makeTask();
    const review = await buildingReview(taskId);
    await reviews.markReady(review.id, fakeSha('current'));

    await expect(
      reviews.claimForApply(review.id, fakeSha('what-the-browser-saw')),
    ).rejects.toMatchObject({ code: 'REVIEW_STALE' });
  });

  it('lets exactly one of two simultaneous applies claim it', async () => {
    const taskId = await makeTask();
    const review = await buildingReview(taskId);
    await reviews.markReady(review.id, fakeSha('cand'));

    const begin = () =>
      reviews
        .claimForApply(review.id, fakeSha('cand'))
        .then(() =>
          reviews.begin({
            workspaceId, reviewId: review.id,
            expectedMainSha: fakeSha('main'), candidateSha: fakeSha('cand'), bootId: BOOT_ID,
          }),
        );

    const results = await Promise.allSettled([begin(), begin()]);
    const created = results.filter((r) => r.status === 'fulfilled' && r.value.created);
    expect(created).toHaveLength(1);
  });

  it('leaves an applied review untouched by later edits', async () => {
    const taskId = await makeTask();
    const review = await buildingReview(taskId);
    await reviews.markReady(review.id, fakeSha('cand'));
    await reviews.markApplied(review.id);

    await reviews.invalidateForTask(taskId, 'typing continued');
    expect((await reviews.read(review.id))!.status).toBe('applied');
  });
});

describe('finding the reviews on a task', () => {
  /**
   * The discovery route exists because the only other path to a review ID is
   * POST /tasks/:t/review, which builds a Git candidate and refuses from a
   * dozen states. A screen cannot call that to find out what it is showing.
   */
  async function listReviews(taskId: string, ws = workspaceId) {
    return t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/tasks/${taskId}/reviews`,
    });
  }

  async function review(taskId: string) {
    return reviews.create({
      workspaceId, taskId, runId: null,
      source: {
        taskVersion: 1, guidanceVersion: 1, mainSha: fakeSha('main'),
        humanSha: fakeSha('human'), resultSha: null, documentRevisions: {},
        contextHash: 'ctx',
      },
    });
  }

  it('returns reviews newest first, including historical ones', async () => {
    const taskId = await makeTask();
    const older = await review(taskId);
    await reviews.markReady(older.id, fakeSha('old'));
    const newer = await review(taskId);

    const body = (await listReviews(taskId)).json();
    expect(body.reviews.map((r: { id: string }) => r.id)).toEqual([newer.id, older.id]);
    // A stale or applied review is not noise: it explains why an Apply that was
    // offered a moment ago no longer is.
    expect(body.reviews[1].status).toBe('ready');
  });

  it('carries metadata only, never the candidate artifact', async () => {
    const taskId = await makeTask();
    await review(taskId);

    const raw = (await listReviews(taskId)).body;
    // Reading a candidate means reading Git, and a building review has no SHA
    // to read. Details would cost one Git read per row and fail on the newest.
    expect(raw).not.toContain('changedFiles');
    expect(raw).not.toContain('conflicts');
    expect(JSON.parse(raw).reviews[0].candidateSha).toBeNull();
  });

  it('is empty for a task nobody has requested review on', async () => {
    const taskId = await makeTask();
    const res = await listReviews(taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().reviews).toEqual([]);
  });

  it('reports a task from another workspace as absent', async () => {
    const taskId = await makeTask();
    await review(taskId);
    const other = (await createWorkspaceViaApi(t.app, { name: 'Elsewhere reviews' })).workspaceId;

    const res = await listReviews(taskId, other);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TASK_NOT_FOUND');
  });
});

describe('apply operations', () => {
  async function readyReview(taskId: string) {
    const review = await reviews.create({
      workspaceId, taskId, runId: null,
      source: {
        taskVersion: 1, guidanceVersion: 1, mainSha: fakeSha('main'),
        humanSha: fakeSha('human'), resultSha: null, documentRevisions: {}, contextHash: 'ctx',
      },
    });
    await reviews.markReady(review.id, fakeSha('cand'));
    return review;
  }

  it('records intent once per review', async () => {
    // Section 10.5: two records for one review would make reconciliation
    // ambiguous, which is the state the design says to stop on.
    const taskId = await makeTask();
    const review = await readyReview(taskId);
    const args = {
      workspaceId, reviewId: review.id,
      expectedMainSha: fakeSha('main'), candidateSha: fakeSha('cand'), bootId: BOOT_ID,
    };

    const first = await reviews.begin(args);
    const second = await reviews.begin(args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.operation.id).toBe(first.operation.id);
  });

  it('surfaces operations stranded by a previous process', async () => {
    // Section 14.4 step 4, and 10.5's reconciliation against main.
    const taskId = await makeTask();
    const review = await readyReview(taskId);
    const previousBoot = randomUUID();
    await reviews.begin({
      workspaceId, reviewId: review.id,
      expectedMainSha: fakeSha('main'), candidateSha: fakeSha('cand'), bootId: previousBoot,
    });

    const pending = await reviews.pendingFromPreviousBoots(BOOT_ID);
    expect(pending.map((p) => p.review_id)).toContain(review.id);

    // Once reconciled it drops out.
    await reviews.settle(review.id, 'applied');
    const after = await reviews.pendingFromPreviousBoots(BOOT_ID);
    expect(after.map((p) => p.review_id)).not.toContain(review.id);
  });

  it('does not resurface an operation from this boot', async () => {
    const taskId = await makeTask();
    const review = await readyReview(taskId);
    await reviews.begin({
      workspaceId, reviewId: review.id,
      expectedMainSha: fakeSha('main'), candidateSha: fakeSha('cand'), bootId: BOOT_ID,
    });

    const pending = await reviews.pendingFromPreviousBoots(BOOT_ID);
    expect(pending.map((p) => p.review_id)).not.toContain(review.id);
  });
});
