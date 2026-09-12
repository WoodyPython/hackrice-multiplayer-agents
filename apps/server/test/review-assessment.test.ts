import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TIMEOUT_MS, reviewDetailSchema, type AgentResponse, type ReviewDetail } from '@app/contracts';
import type { DbHandle } from '../src/db/client.js';
import { FakeModelAdapter } from '../src/models/fake.js';
import { ModelAdapterError } from '../src/models/types.js';
import { ReviewAssessmentError, ReviewAssessor, type ReviewReader } from '../src/orchestration/review-assessment.js';
import { ReviewEvidenceComposer } from '../src/orchestration/review-evidence.js';
import { startRuntime } from '../src/recovery/runtime.js';
import { appendEvent } from '../src/events/service.js';
import { connectTestDb, insertAgentInstance, insertBudget, insertRun, insertTask, insertWorkspace, testDatabaseUrl } from './helpers.js';
import { testConfig } from './app-helpers.js';

let db: DbHandle;
const sha = () => randomUUID().replace(/-/g, '').padEnd(40, '0');

/** A stub `ReviewReader` returning one fixed candidate, so `ReviewAssessor`
 * tests never depend on Git or D06's build pipeline. The task/workspace rows
 * still have to be real: the assessor reads title/outcome/criteria/guidance
 * straight from the database, not from the review detail. */
function stubReview(taskId: string): { reader: ReviewReader; detail: ReviewDetail } {
  const detail = reviewDetailSchema.parse({
    review: { id: randomUUID(), taskId, runId: null,
      source: { taskVersion: 1, guidanceVersion: 1, mainSha: sha(), humanSha: sha(), resultSha: null,
        documentRevisions: {}, contextHash: 'x'.repeat(64) },
      candidateSha: sha(), status: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    candidateSha: sha(), candidateComplete: true, conflicts: [],
    changedFiles: [{ path: 'documents/a.md', changeKind: 'modified', diff: '+line', beforeHash: sha(), afterHash: sha() }],
    generatedCodeWasNotExecuted: true,
  });
  return { reader: { read: async () => detail }, detail };
}

const structured = (summary: string, limitations: string[] = []): AgentResponse => ({
  text: JSON.stringify({ summary, limitations }), toolCalls: [], finishReason: 'STOP',
  usage: { status: 'reported', totalTokens: 500 },
});

describe('C07 review assessment', () => {
  beforeEach(() => { db = connectTestDb(); });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await db.close(); });

  const budget = (taskId: string, agentKey: string) =>
    db.db.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', taskId).where('agent_key', '=', agentKey).executeTakeFirst();
  const events = (taskId: string) => db.db.selectFrom('task_events').selectAll().where('task_id', '=', taskId).execute();

  /** Real workspace/task rows: the assessor reads title/outcome/criteria/
   * guidance straight from the database, not from the stubbed review detail. */
  async function fixture() {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId);
    const { reader, detail } = stubReview(taskId);
    return { workspaceId, taskId, reader, detail };
  }

  it('records a fresh assessment, labels it generated, and accounts real usage against a dedicated budget', async () => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    const adapter = new FakeModelAdapter([{ inputTokens: 120, result: structured('Meets the outcome.', ['Could not verify tests.']) }]);
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader });

    const result = await assessor.assess({ workspaceId, taskId, reviewId: detail.review.id });
    expect(result).toEqual({ agentKey: `review:${detail.review.id}`, summary: 'Meets the outcome.',
      limitations: 'Could not verify tests.', examinedSha: detail.candidateSha, generatedCodeWasNotExecuted: true });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.request.preset).toBe('reviewer');
    expect(adapter.calls[0]!.request.tools).toBeUndefined();

    const row = await budget(taskId, `review:${detail.review.id}`);
    expect(row).toMatchObject({ consumed_tokens: 500, reserved_tokens: 0 });

    const recorded = await events(taskId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ type: 'review.assessed', run_id: null,
      event_key: `review:${detail.review.id}:assessed:${detail.candidateSha}` });
    expect((recorded[0]!.payload as { result: unknown }).result).toEqual(result);
  });

  it('is idempotent per exact candidate: a repeat request returns the recorded result without a second call', async () => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    const adapter = new FakeModelAdapter([{ inputTokens: 10, result: structured('First pass.') }]);
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader });
    const input = { workspaceId, taskId, reviewId: detail.review.id };

    const first = await assessor.assess(input);
    const second = await assessor.assess(input);
    expect(second).toEqual(first);
    expect(adapter.calls).toHaveLength(1);
    expect(await events(taskId)).toHaveLength(1);
  });

  it('coalesces genuinely concurrent requests for the same review into one call', async () => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    const gate = (() => { let resolve!: () => void; const promise = new Promise<void>((d) => { resolve = d; }); return { promise, resolve }; })();
    const adapter = new FakeModelAdapter([{ inputTokens: 10, result: async () => { await gate.promise; return structured('Done.'); } }]);
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader });
    const input = { workspaceId, taskId, reviewId: detail.review.id };

    const both = Promise.all([assessor.assess(input), assessor.assess(input)]);
    gate.resolve();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(adapter.calls).toHaveLength(1);
  });

  it('refuses when the task budget cannot fund even the minimum output, and reserves nothing', async () => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    const adapter = new FakeModelAdapter([{ inputTokens: 10, result: structured('unused') }]);
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader });
    await db.db.insertInto('task_agent_budgets').values({
      workspace_id: workspaceId, task_id: taskId, agent_key: `review:${detail.review.id}`,
      token_budget: 5, consumed_tokens: 5,
    }).execute();

    await expect(assessor.assess({ workspaceId, taskId, reviewId: detail.review.id }))
      .rejects.toMatchObject({ code: 'token_exhausted' });
    expect(adapter.calls).toHaveLength(0);
    const row = await budget(taskId, `review:${detail.review.id}`);
    expect(row).toMatchObject({ reserved_tokens: 0, consumed_tokens: 5 });
    expect(await events(taskId)).toHaveLength(0);
  });

  it('retries a retryable provider error and settles usage for every attempt, including the failed one', async () => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    const failure = new ModelAdapterError('rate_limited', 'slow down', true, 429, { status: 'reported', totalTokens: 7 });
    const adapter = new FakeModelAdapter([
      { inputTokens: 10, result: failure },
      { inputTokens: 10, result: structured('Second attempt succeeded.') },
    ]);
    const wait = vi.fn(async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); });
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader, wait });
    const result = await assessor.assess({ workspaceId, taskId, reviewId: detail.review.id });
    expect(result.summary).toBe('Second attempt succeeded.');
    expect(adapter.calls).toHaveLength(2);
    expect(wait).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    const row = await budget(taskId, `review:${detail.review.id}`);
    // 7 (failed attempt's reported usage) + 500 (the fake step's default usage).
    expect(row).toMatchObject({ consumed_tokens: 507, reserved_tokens: 0 });
  });

  it.each(['success', 'failure', 'missing_total'] as const)('retains reservations for unknown usage on %s', async (kind) => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    const usage = kind === 'missing_total' ? { status: 'reported' as const } : { status: 'unknown' as const };
    const adapter = new FakeModelAdapter([{ inputTokens: 10, result: kind === 'failure'
      ? new ModelAdapterError('provider_error', 'Unknown bill', false)
      : { ...structured('Finding.'), usage } }]);
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader });
    const assessment = assessor.assess({ workspaceId, taskId, reviewId: detail.review.id });
    if (kind === 'failure') await expect(assessment).rejects.toBeInstanceOf(ModelAdapterError);
    else await assessment;
    const row = await budget(taskId, `review:${detail.review.id}`);
    expect(row!.reserved_tokens).toBeGreaterThan(0);
    expect(row!.consumed_tokens).toBe(0);
    // A new candidate cannot reuse the unaccounted allowance.
    detail.candidateSha = sha();
    const next = new ReviewAssessor({ db: db.db, reviews: reader,
      adapter: new FakeModelAdapter([{ inputTokens: 10, result: structured('Unused') }]) });
    await expect(next.assess({ workspaceId, taskId, reviewId: detail.review.id })).rejects.toMatchObject({ code: 'token_exhausted' });
  });

  it.each(['count', 'generate'] as const)('times out an abort-ignoring %s and never publishes its late result', async (phase) => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    const adapter = new FakeModelAdapter([{ inputTokens: 10, result: async () => {
      reached = true; await gate; return structured('Too late');
    } }]);
    if (phase === 'count') vi.spyOn(adapter, 'countInput').mockImplementation(async () => {
      reached = true; await gate; return 10;
    });
    const background: unknown[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader, onBackgroundError: (e) => background.push(e) });
    const pending = assessor.assess({ workspaceId, taskId, reviewId: detail.review.id });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timed_out' });
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS);
      await rejected;
    } finally { vi.useRealTimers(); release(); }
    if (phase === 'generate') {
      await vi.waitFor(async () => expect(await budget(taskId, `review:${detail.review.id}`))
        .toMatchObject({ consumed_tokens: 500, reserved_tokens: 0 }));
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await budget(taskId, `review:${detail.review.id}`)).toBeUndefined();
      expect(adapter.calls).toHaveLength(0);
    }
    expect(await events(taskId)).toHaveLength(0);
    expect(background).toEqual([]);
  });

  it('rejects a blocked response without recording a fabricated finding', async () => {
    const { workspaceId, taskId, reader, detail } = await fixture();
    const adapter = new FakeModelAdapter([{ inputTokens: 10, result: { toolCalls: [], blockReason: 'SAFETY',
      usage: { status: 'reported', totalTokens: 3 } } }]);
    const assessor = new ReviewAssessor({ db: db.db, adapter, reviews: reader });
    await expect(assessor.assess({ workspaceId, taskId, reviewId: detail.review.id }))
      .rejects.toBeInstanceOf(ReviewAssessmentError);
    expect(await events(taskId)).toHaveLength(0);
    // Budget is still settled even though the finding was refused.
    const row = await budget(taskId, `review:${detail.review.id}`);
    expect(row).toMatchObject({ reserved_tokens: 0, consumed_tokens: 3 });
  });

  it('refuses when the caller names a task the review does not belong to', async () => {
    const { workspaceId, reader, detail } = await fixture();
    const assessor = new ReviewAssessor({ db: db.db, adapter: new FakeModelAdapter([]), reviews: reader });
    await expect(assessor.assess({ workspaceId, taskId: randomUUID(), reviewId: detail.review.id }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('C07 review evidence', () => {
  beforeEach(() => { db = connectTestDb(); });
  afterEach(async () => { await db.close(); });

  it('labels an in-run agent summary as generated, stamps its examined SHA, and flags staleness against a moved candidate', async () => {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId);
    const runId = await insertRun(db.db, workspaceId, taskId, { status: 'completed' });
    const resultSha = sha(), approvedAtRunTime = sha(), draftAtRunTime = sha();
    await db.db.updateTable('runs').set({
      result_head_sha: resultSha,
      context_manifest: { taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [],
        approvedPaths: [], approvedCommitSha: approvedAtRunTime, draftCheckpointSha: draftAtRunTime, draftFileHashes: {} },
    }).where('id', '=', runId).execute();
    await insertBudget(db.db, workspaceId, taskId, 'faq');
    const agentId = await insertAgentInstance(db.db, workspaceId, taskId, runId, { preset: 'writer', agent_key: 'faq', assignment_key: 'faq' });
    await db.db.updateTable('agent_instances').set({ status: 'completed' }).where('id', '=', agentId).execute();
    await appendEvent(db.db, { workspaceId, taskId, runId, eventKey: `agent:${agentId}:completed`, type: 'agent.completed',
      payload: { agentId, result: { summary: 'Drafted the FAQ from confirmed facts.', references: [],
        limitations: ['Pricing was not confirmed.'], artifacts: [], resultSha } } });

    const composer = new ReviewEvidenceComposer({ db: db.db });
    const evidence = await composer.compose({
      workspaceId, taskId, reviewId: randomUUID(), candidateSha: sha(), candidateComplete: true,
      unresolvedConflicts: 0, changedFiles: [{ path: 'documents/faq.md', changeKind: 'modified', diff: '+x' }],
      runId, source: { mainSha: approvedAtRunTime, humanSha: sha() /* diverged from draftAtRunTime */ },
    });

    expect(evidence.agentSummaries).toEqual([{ agentKey: 'faq', summary: 'Drafted the FAQ from confirmed facts.',
      limitations: 'Pricing was not confirmed.', examinedSha: resultSha, staleAgainstCandidate: true }]);
    expect(evidence.generatedCodeWasNotExecuted).toBe(true);
    expect(evidence.validationsPerformed).toEqual(expect.arrayContaining([
      { check: 'Every required assignment reached a terminal, completed state', passed: true, detail: null },
    ]));
  });

  it('marks an in-run summary current when the candidate matches exactly what the run examined', async () => {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId);
    const runId = await insertRun(db.db, workspaceId, taskId, { status: 'completed' });
    const resultSha = sha(), main = sha(), human = sha();
    await db.db.updateTable('runs').set({ result_head_sha: resultSha,
      context_manifest: { taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [],
        approvedPaths: [], approvedCommitSha: main, draftCheckpointSha: human, draftFileHashes: {} } }).where('id', '=', runId).execute();
    await insertBudget(db.db, workspaceId, taskId, 'facts');
    const agentId = await insertAgentInstance(db.db, workspaceId, taskId, runId, { preset: 'analyst', agent_key: 'facts', assignment_key: 'facts' });
    await db.db.updateTable('agent_instances').set({ status: 'completed' }).where('id', '=', agentId).execute();
    await appendEvent(db.db, { workspaceId, taskId, runId, eventKey: `agent:${agentId}:completed`, type: 'agent.completed',
      payload: { agentId, result: { summary: 'Extracted the facts.', references: [], limitations: [], artifacts: [], resultSha } } });

    const evidence = await new ReviewEvidenceComposer({ db: db.db }).compose({
      workspaceId, taskId, reviewId: randomUUID(), candidateSha: sha(), candidateComplete: true, unresolvedConflicts: 0,
      changedFiles: [], runId, source: { mainSha: main, humanSha: human },
    });
    expect(evidence.agentSummaries[0]).toMatchObject({ staleAgainstCandidate: false, limitations: null });
  });

  it('reports an unfinished assignment and an unresolved conflict as real, failing checks', async () => {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId);
    const runId = await insertRun(db.db, workspaceId, taskId, { status: 'completed' });
    await insertBudget(db.db, workspaceId, taskId, 'draft');
    await insertAgentInstance(db.db, workspaceId, taskId, runId, { preset: 'writer', agent_key: 'draft', assignment_key: 'draft' });
    // Left pending: never marked completed.

    const evidence = await new ReviewEvidenceComposer({ db: db.db }).compose({
      workspaceId, taskId, reviewId: randomUUID(), candidateSha: sha(), candidateComplete: false, unresolvedConflicts: 2,
      changedFiles: [], runId, source: { mainSha: sha(), humanSha: sha() },
    });
    expect(evidence.validationsPerformed).toEqual(expect.arrayContaining([
      { check: 'Combined candidate has no unresolved conflicts', passed: false, detail: '2 file(s) still need resolution before this candidate is appliable.' },
      { check: 'Every required assignment reached a terminal, completed state', passed: false, detail: null },
    ]));
  });

  it('folds a fresh review.assessed event into evidence, and flags it stale once a newer candidate is resolved', async () => {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId, { kind: 'manual_edit', manual_source_path: 'documents/a.md' });
    const reviewId = randomUUID(), examinedSha = sha(), laterCandidate = sha();
    await appendEvent(db.db, { workspaceId, taskId, runId: null, eventKey: `review:${reviewId}:assessed:${examinedSha}`,
      type: 'review.assessed', payload: { reviewId, candidateSha: examinedSha,
        result: { agentKey: `review:${reviewId}`, summary: 'Looks complete.', limitations: null, examinedSha, generatedCodeWasNotExecuted: true } } });

    const current = await new ReviewEvidenceComposer({ db: db.db }).compose({
      workspaceId, taskId, reviewId, candidateSha: examinedSha, candidateComplete: true, unresolvedConflicts: 0,
      changedFiles: [], runId: null, source: { mainSha: sha(), humanSha: sha() },
    });
    expect(current.agentSummaries).toEqual([{ agentKey: `review:${reviewId}`, summary: 'Looks complete.',
      limitations: null, examinedSha, staleAgainstCandidate: false }]);

    const afterResolution = await new ReviewEvidenceComposer({ db: db.db }).compose({
      workspaceId, taskId, reviewId, candidateSha: laterCandidate, candidateComplete: true, unresolvedConflicts: 0,
      changedFiles: [], runId: null, source: { mainSha: sha(), humanSha: sha() },
    });
    expect(afterResolution.agentSummaries[0]).toMatchObject({ staleAgainstCandidate: true });
  });

  it('never mixes another review\'s assessed events into this one\'s evidence', async () => {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId, { kind: 'manual_edit', manual_source_path: 'documents/a.md' });
    const other = randomUUID(), otherSha = sha();
    await appendEvent(db.db, { workspaceId, taskId, runId: null, eventKey: `review:${other}:assessed:${otherSha}`,
      type: 'review.assessed', payload: { reviewId: other, candidateSha: otherSha,
        result: { agentKey: `review:${other}`, summary: 'Belongs to a different review.', limitations: null, examinedSha: otherSha, generatedCodeWasNotExecuted: true } } });

    const evidence = await new ReviewEvidenceComposer({ db: db.db }).compose({
      workspaceId, taskId, reviewId: randomUUID(), candidateSha: sha(), candidateComplete: true, unresolvedConflicts: 0,
      changedFiles: [], runId: null, source: { mainSha: sha(), humanSha: sha() },
    });
    expect(evidence.agentSummaries).toEqual([]);
  });
});

describe('C07 review routes', () => {
  let root: string;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  beforeEach(async () => {
    db = connectTestDb();
    root = await mkdtemp(join(tmpdir(), 'c07-routes-'));
    runtime = await startRuntime({ config: testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl() }),
      listen: { host: '127.0.0.1', port: 0 } });
  });
  afterEach(async () => { vi.restoreAllMocks(); await runtime?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); });

  it('serves composed evidence for a prepared review, reflecting its real changed files', async () => {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId, { kind: 'manual_edit', manual_source_path: 'documents/shared.md' });
    await runtime.git.checkpoint({ workspaceId, taskId, files: [{ path: 'documents/shared.md', text: 'draft text\n' }] });
    const prepared = await runtime.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${taskId}/review`, payload: {} });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const review = reviewDetailSchema.parse(prepared.json());

    const response = await runtime.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/reviews/${review.review.id}/evidence` });
    expect(response.statusCode, response.body).toBe(200);
    const evidence = response.json();
    expect(evidence.changedFiles).toMatchObject([{ path: 'documents/shared.md', changeKind: 'added' }]);
    expect(evidence.generatedCodeWasNotExecuted).toBe(true);
    expect(evidence.validationsPerformed).toEqual(expect.arrayContaining([
      { check: 'Combined candidate has no unresolved conflicts', passed: true, detail: null },
    ]));
    expect(evidence.agentSummaries).toEqual([]);
  });

  it('reports unconfigured agent execution as a clean error rather than a raw model failure', async () => {
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId, { kind: 'manual_edit', manual_source_path: 'documents/shared.md' });
    await runtime.git.checkpoint({ workspaceId, taskId, files: [{ path: 'documents/shared.md', text: 'draft text\n' }] });
    const prepared = await runtime.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${taskId}/review`, payload: {} });
    const review = reviewDetailSchema.parse(prepared.json());

    const response = await runtime.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/reviews/${review.review.id}/assess` });
    // No GEMINI_API_KEY in the test environment: the shared adapter refuses.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain(root);
  });
});
