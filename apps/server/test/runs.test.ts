import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TIMEOUT_MS, TASK_AGENT_TOKEN_BUDGET, type AgentPlan } from '@app/contracts';
import { PgBudgetLedger, billableTokens } from '../src/runs/budget-ledger.js';
import { PgRunStore, assertAcyclic } from '../src/runs/run-store.js';
import { PgReviewStore } from '../src/runs/review-store.js';
import { BOOT_ID, fakeSha } from './helpers.js';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';

/**
 * B07 acceptance (design sections 8.3, 9.2, 9.3, 10.1, 10.3, 10.5, 11.2, 14.4).
 *
 * The ledger gets the most attention here. It is the one piece where a wrong
 * answer is invisible: an over-refunded budget lets an agent run forever while
 * its recorded usage looks fine, and a double-charge stops it early for no
 * reason a log would explain.
 */

let t: TestApp;
let ledger: PgBudgetLedger;
let runs: PgRunStore;
let reviews: PgReviewStore;
let workspaceId: string;

beforeAll(async () => {
  t = await buildTestApp();
  ledger = new PgBudgetLedger({ db: t.handle.db });
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
  return row.id;
}

async function makeAgent(
  taskId: string,
  runId: string,
  agentKey = 'orchestrator',
  budget = TASK_AGENT_TOKEN_BUDGET,
): Promise<string> {
  await ledger.ensure(workspaceId, taskId, agentKey, budget);
  const row = await t.handle.db
    .insertInto('agent_instances')
    .values({
      workspace_id: workspaceId,
      task_id: taskId,
      run_id: runId,
      agent_key: agentKey,
      assignment_key: agentKey,
      preset: 'writer',
      model_id: 'gemini-2.5-flash',
      boot_id: BOOT_ID,
      status: 'pending',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
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

// ---------------------------------------------------------------------------

describe('token ledger', () => {
  it('reserves against the remaining budget and reports what is left', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    const result = await ledger.reserve({
      agentInstanceId: agentId,
      requestKey: 'call-1',
      tokens: 300,
      modelId: 'gemini-2.5-flash',
    });

    expect(result.reserved).toBe(true);
    expect(result.budget.reservedTokens).toBe(300);
    expect(result.budget.consumedTokens).toBe(0);
    expect(result.remainingTokens).toBe(700);
  });

  it('refuses once the budget is spoken for', async () => {
    // Section 9.3 step 4: "Stop before the call if insufficient allowance
    // remains."
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    await ledger.reserve({ agentInstanceId: agentId, requestKey: 'a', tokens: 800, modelId: 'm' });
    await expect(
      ledger.reserve({ agentInstanceId: agentId, requestKey: 'b', tokens: 300, modelId: 'm' }),
    ).rejects.toMatchObject({ code: 'AGENT_TOKEN_EXHAUSTED' });
  });

  it('never lets concurrent reservations exceed the budget', async () => {
    /*
     * The reason the check and the reservation are one statement. Ten calls of
     * 200 against a budget of 1000: a read-then-write would let several of them
     * all see enough headroom and all take it.
     */
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ledger.reserve({
          agentInstanceId: agentId,
          requestKey: `concurrent-${i}`,
          tokens: 200,
          modelId: 'm',
        }),
      ),
    );

    const granted = results.filter((r) => r.status === 'fulfilled');
    expect(granted).toHaveLength(5);

    const budget = await ledger.read(taskId, 'writer-1');
    expect(budget!.reservedTokens).toBe(1000);
    expect(budget!.reservedTokens + budget!.consumedTokens).toBeLessThanOrEqual(
      budget!.tokenBudget,
    );
  });

  it('is idempotent on the request key', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    await ledger.reserve({ agentInstanceId: agentId, requestKey: 'same', tokens: 100, modelId: 'm' });
    const replay = await ledger.reserve({
      agentInstanceId: agentId,
      requestKey: 'same',
      tokens: 100,
      modelId: 'm',
    });

    expect(replay.reserved).toBe(false);
    expect((await ledger.read(taskId, 'writer-1'))!.reservedTokens).toBe(100);
  });

  it('settles against reported usage and releases the reservation', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    await ledger.reserve({ agentInstanceId: agentId, requestKey: 'c', tokens: 400, modelId: 'm' });
    const after = await ledger.reconcile({
      agentInstanceId: agentId,
      requestKey: 'c',
      usage: { status: 'reported', totalTokens: 250 },
    });

    expect(after.reservedTokens).toBe(0);
    expect(after.consumedTokens).toBe(250);
  });

  it('charges the reservation when usage never arrives', async () => {
    /*
     * Section 9.3: "For missing usage after a failed request, retain its
     * reservation as unknown rather than giving the agent that budget back."
     * Refunding here would let an agent that keeps failing burn unbounded
     * provider capacity while its recorded usage stayed at zero.
     */
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    await ledger.reserve({ agentInstanceId: agentId, requestKey: 'lost', tokens: 400, modelId: 'm' });
    const after = await ledger.abandon({ agentInstanceId: agentId, requestKey: 'lost' });

    expect(after.consumedTokens).toBe(400);
    expect(after.reservedTokens).toBe(0);

    const call = await t.handle.db
      .selectFrom('model_calls')
      .select('status')
      .where('agent_id', '=', agentId)
      .where('request_key', '=', 'lost')
      .executeTakeFirstOrThrow();
    expect(call.status).toBe('unknown');
  });

  it('does not double-charge a settle that arrives twice', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    await ledger.reserve({ agentInstanceId: agentId, requestKey: 'd', tokens: 300, modelId: 'm' });
    await ledger.reconcile({
      agentInstanceId: agentId,
      requestKey: 'd',
      usage: { status: 'reported', totalTokens: 300 },
    });
    const again = await ledger.reconcile({
      agentInstanceId: agentId,
      requestKey: 'd',
      usage: { status: 'reported', totalTokens: 300 },
    });

    expect(again.consumedTokens).toBe(300);
    expect(again.reservedTokens).toBe(0);
  });

  it('survives usage that overshoots its reservation', async () => {
    // Section 9.2 records late usage, and 9.3 reconciles against
    // provider-reported totals, either of which can exceed what was reserved.
    // The budget row deliberately has no check that would make this fail.
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer-1', 1000);

    await ledger.reserve({ agentInstanceId: agentId, requestKey: 'e', tokens: 100, modelId: 'm' });
    const after = await ledger.reconcile({
      agentInstanceId: agentId,
      requestKey: 'e',
      usage: { status: 'reported', totalTokens: 5000 },
    });

    expect(after.consumedTokens).toBe(5000);
    // And the agent is now correctly unable to reserve anything more.
    await expect(
      ledger.reserve({ agentInstanceId: agentId, requestKey: 'f', tokens: 1, modelId: 'm' }),
    ).rejects.toMatchObject({ code: 'AGENT_TOKEN_EXHAUSTED' });
  });

  it('keeps budgets independent across tasks for the same agent', async () => {
    // Section 9.3: "The same agent working on another task receives an
    // independent budget."
    const taskA = await makeTask('A');
    const taskB = await makeTask('B');
    const runA = await makeRun(taskA);
    const runB = await makeRun(taskB);
    const agentA = await makeAgent(taskA, runA, 'writer', 1000);
    await makeAgent(taskB, runB, 'writer', 1000);

    await ledger.reserve({ agentInstanceId: agentA, requestKey: 'x', tokens: 900, modelId: 'm' });

    expect((await ledger.read(taskB, 'writer'))!.reservedTokens).toBe(0);
  });

  it('keeps accumulated usage when a retry creates a new instance', async () => {
    // Section 14.3: "An exhausted budget remains exhausted on retry."
    const taskId = await makeTask();
    const run1 = await makeRun(taskId, 1);
    const agent1 = await makeAgent(taskId, run1, 'writer', 1000);
    await ledger.reserve({ agentInstanceId: agent1, requestKey: 'g', tokens: 1000, modelId: 'm' });
    await ledger.reconcile({
      agentInstanceId: agent1,
      requestKey: 'g',
      usage: { status: 'reported', totalTokens: 1000 },
    });

    // A real retry settles the previous attempt first; runs_active_uq refuses
    // a second active run, which is the invariant B03 relies on.
    await runs.settle(run1, 'canceled');
    const run2 = await makeRun(taskId, 2);
    const agent2 = await makeAgent(taskId, run2, 'writer', 1000);

    expect((await ledger.read(taskId, 'writer'))!.consumedTokens).toBe(1000);
    await expect(
      ledger.reserve({ agentInstanceId: agent2, requestKey: 'h', tokens: 1, modelId: 'm' }),
    ).rejects.toMatchObject({ code: 'AGENT_TOKEN_EXHAUSTED' });
  });
});

describe('billable tokens', () => {
  it('uses the reported total and never adds components to it', () => {
    // Section 9.3: "do not sum total plus its components." Summing both roughly
    // doubles every charge.
    expect(
      billableTokens(
        { status: 'reported', totalTokens: 500, inputTokens: 400, outputTokens: 100 },
        999,
      ),
    ).toBe(500);
  });

  it('sums components only when no total was reported', () => {
    expect(
      billableTokens({ status: 'reported', inputTokens: 400, outputTokens: 100 }, 999),
    ).toBe(500);
  });

  it('includes thinking tokens in the component sum', () => {
    expect(
      billableTokens(
        { status: 'reported', inputTokens: 100, outputTokens: 50, thinkingTokens: 200 },
        999,
      ),
    ).toBe(350);
  });

  it('never adds cached input on top of a total that already covers it', () => {
    // "Cached input remains part of logical token usage; do not add it twice if
    // already included in prompt/total counts."
    expect(
      billableTokens(
        { status: 'reported', totalTokens: 500, cachedInputTokens: 300 },
        999,
      ),
    ).toBe(500);
  });

  it('falls back to the reservation when nothing usable was reported', () => {
    expect(billableTokens({ status: 'unknown' }, 750)).toBe(750);
    expect(billableTokens({ status: 'reported' }, 750)).toBe(750);
  });
});

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

describe('agent instances', () => {
  it('materialises a plan with its dependency edges', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    for (const a of PLAN.assignments) await ledger.ensure(workspaceId, taskId, a.id);

    const created = await runs.createInstancesFromPlan({
      workspaceId,
      taskId,
      runId,
      plan: PLAN,
      modelId: 'gemini-2.5-flash',
    });

    expect(created).toHaveLength(4);
    const faq = created.find((a) => a.assignmentKey === 'faq')!;
    const facts = created.find((a) => a.assignmentKey === 'facts')!;
    expect(faq.dependsOn).toEqual([facts.id]);
    expect(facts.dependsOn).toEqual([]);
  });

  it('reports only assignments whose prerequisites have completed', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    for (const a of PLAN.assignments) await ledger.ensure(workspaceId, taskId, a.id);
    const created = await runs.createInstancesFromPlan({
      workspaceId, taskId, runId, plan: PLAN, modelId: 'm',
    });

    // Only the root is ready.
    let ready = await runs.readyInstances(runId);
    expect(ready.map((a) => a.assignmentKey)).toEqual(['facts']);

    // Completing it releases both writers at once — section 8.7's parallelism.
    const facts = created.find((a) => a.assignmentKey === 'facts')!;
    await runs.start(facts.id, AGENT_TIMEOUT_MS);
    await runs.settleInstance(facts.id, 'completed');

    ready = await runs.readyInstances(runId);
    expect(ready.map((a) => a.assignmentKey).sort()).toEqual(['announce', 'faq']);
  });

  it('derives the deadline rather than accepting one', async () => {
    // Section 9.2: the ten-minute value is fixed, with no environment override.
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer');

    const started = await runs.start(agentId, AGENT_TIMEOUT_MS);
    const elapsed =
      Date.parse(started.deadlineAt!) - Date.parse(started.startedAt!);
    expect(elapsed).toBe(AGENT_TIMEOUT_MS);
  });

  it('does not restart the clock on a second start', async () => {
    // "Replanning, provider retries, and repeated tool calls do not reset the
    // same agent's deadline."
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer');

    const first = await runs.start(agentId, AGENT_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 20));
    const second = await runs.start(agentId, AGENT_TIMEOUT_MS);

    expect(second.deadlineAt).toBe(first.deadlineAt);
  });

  it('refuses a write from an expired instance', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer');
    await runs.start(agentId, -1_000); // already past

    await expect(runs.assertWritable(agentId)).rejects.toMatchObject({
      code: 'AGENT_TIMED_OUT',
    });
  });

  it('refuses a write from a terminal instance', async () => {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer');
    await runs.start(agentId, AGENT_TIMEOUT_MS);
    await runs.settleInstance(agentId, 'timed_out');

    await expect(runs.assertWritable(agentId)).rejects.toMatchObject({
      code: 'AGENT_TIMED_OUT',
    });
  });
});

describe('the database refuses late writes from terminal instances', () => {
  /*
   * Section 11.2 asks for this at the database level, and the asymmetry with
   * task transitions is the point: an agent write can arrive from a detached
   * async context with no request holding a lock to check it. Section 9.2:
   * "canceling a local request does not guarantee the provider stopped."
   */
  async function terminalAgent(): Promise<string> {
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer');
    await runs.start(agentId, AGENT_TIMEOUT_MS);
    await runs.settleInstance(agentId, 'timed_out');
    return agentId;
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
    const taskId = await makeTask();
    const runId = await makeRun(taskId);
    const agentId = await makeAgent(taskId, runId, 'writer', 1000);
    await ledger.reserve({ agentInstanceId: agentId, requestKey: 'late', tokens: 200, modelId: 'm' });
    await runs.start(agentId, AGENT_TIMEOUT_MS);
    await runs.settleInstance(agentId, 'timed_out');

    const after = await ledger.reconcile({
      agentInstanceId: agentId,
      requestKey: 'late',
      usage: { status: 'reported', totalTokens: 180 },
    });
    expect(after.consumedTokens).toBe(180);
  });
});

describe('startup reconciliation', () => {
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
    await ledger.ensure(workspaceId, taskId, 'stranded');
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

    const run = await t.handle.db
      .selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('working');
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

    const results = await Promise.allSettled([
      reviews
        .claimForApply(review.id, fakeSha('cand'))
        .then(() => reviews.begin({
          workspaceId, reviewId: review.id,
          expectedMainSha: fakeSha('main'), candidateSha: fakeSha('cand'), bootId: BOOT_ID,
        })),
      reviews
        .claimForApply(review.id, fakeSha('cand'))
        .then(() => reviews.begin({
          workspaceId, reviewId: review.id,
          expectedMainSha: fakeSha('main'), candidateSha: fakeSha('cand'), bootId: BOOT_ID,
        })),
    ]);

    const created = results.filter(
      (r) => r.status === 'fulfilled' && r.value.created,
    );
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
