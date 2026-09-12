import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TIMEOUT_MS, retryTaskRequestSchema, postTaskRequestSchema } from '@app/contracts';
import { PgAgentLedger } from '../src/agents/ledger.js';
import { PgCheckpointStore } from '../src/collaboration/checkpoint-store.js';
import { LiveDocumentCoordinator } from '../src/collaboration/coordinator.js';
import { PgDraftStore } from '../src/drafts/store.js';
import { LocalGitService } from '../src/git/service.js';
import { LocalDiskBlobStore } from '../src/materials/blob-store.js';
import { PgMaterialService } from '../src/materials/service.js';
import { FakeModelAdapter, ModelAdapterError, type AgentResponse, type FakeModelStep } from '../src/models/index.js';
import { OrchestratorPlanner, ParallelAssignmentScheduler, StartOrchestrator } from '../src/orchestration/index.js';
import { StartCapture } from '../src/orchestration/capture.js';
import { PgTaskService } from '../src/tasks/service.js';
import { PgRunStore } from '../src/runs/run-store.js';
import { WorkerExecutor } from '../src/workers/executor.js';
import { BOOT_ID, connectTestDb, insertWorkspace } from './helpers.js';
import type { DbHandle } from '../src/db/client.js';

let db: DbHandle, root: string, clock: number;
let coordinator: LiveDocumentCoordinator | undefined, orchestrator: StartOrchestrator | undefined;
const errors: unknown[] = [];
const releaseProviders: Array<() => void> = [];
const path = 'documents/answer.md';
const plan = { summary: 'Saved work', assignments: [{ id: 'writer', preset: 'writer', dependsOn: [], writePaths: [path], instruction: 'Write the answer' }] };
const response = (name: string, args: Record<string, unknown>): AgentResponse => ({
  toolCalls: [{ name, arguments: args }], finishReason: 'STOP', usage: { status: 'reported', totalTokens: 100 },
});
const done = () => response('finish_assignment', { summary: 'Done', references: [], limitations: [], outputPaths: [] });
const planned: FakeModelStep = { inputTokens: 10, result: { text: JSON.stringify(plan), toolCalls: [], finishReason: 'STOP', usage: { status: 'reported', totalTokens: 100 } } };
beforeEach(async () => { db = connectTestDb(); root = await mkdtemp(join(tmpdir(), 'c08-')); clock = Date.now(); errors.length = 0; });
afterEach(async () => { releaseProviders.splice(0).forEach((release) => release()); await orchestrator?.close(); await coordinator?.close(); await db.close(); await rm(root, { recursive: true, force: true }); expect(errors).toEqual([]); });

async function fixture(steps: FakeModelStep[]) {
  const workspaceId = await insertWorkspace(db.db, 'C08');
  const git = new LocalGitService(root), drafts = new PgDraftStore({ db: db.db });
  coordinator = new LiveDocumentCoordinator({ drafts, git, debounceMs: 60000 }, { drafts, git, checkpoints: new PgCheckpointStore(db.db) });
  const materials = new PgMaterialService({ db: db.db, blobs: new LocalDiskBlobStore(join(root, 'materials')) });
  const ledger = new PgAgentLedger({ db: db.db, bootId: BOOT_ID, now: () => new Date(clock) });
  const adapter = new FakeModelAdapter(steps), onBackgroundError = (e: unknown) => errors.push(e);
  const workers = new WorkerExecutor({ db: db.db, ledger, adapter, git, materials, now: () => clock, onBackgroundError });
  orchestrator = new StartOrchestrator({ db: db.db, bootId: BOOT_ID, ledger, adapter, git, drafts, materials, collaboration: coordinator,
    planner: new OrchestratorPlanner({ db: db.db, bootId: BOOT_ID, ledger, adapter, now: () => clock, onBackgroundError }),
    scheduler: new ParallelAssignmentScheduler({ db: db.db, bootId: BOOT_ID, ledger, adapter, workers, git }), onBackgroundError });
  const tasks = new PgTaskService({ db: db.db, bootId: BOOT_ID, orchestration: orchestrator });
  const task = await tasks.post(workspaceId, postTaskRequestSchema.parse({ title: 'Answer', outcome: '', criteria: [], creatorGuestLabel: 'Guest Cedar', clientRequestId: randomUUID() }));
  const start = () => tasks.start(workspaceId, task.id, { expectedVersion: 1, clientRequestId: randomUUID() });
  const retry = (savedOutputs: Array<{ agentInstanceId: string; path: string }> = []) => tasks.retry(workspaceId, task.id,
    { clientRequestId: randomUUID(), savedOutputs });
  return { workspaceId, git, tasks, task, start, retry, adapter, ledger };
}
const run = (id: string) => db.db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const agents = (id: string) => db.db.selectFrom('agent_instances').selectAll().where('run_id', '=', id).execute();
async function settled(id: string) {
  await vi.waitFor(async () => expect((await run(id)).ended_at).not.toBeNull(), { timeout: 60000, interval: 30 });
  return run(id);
}

describe('C08 explicit retries', { timeout: 120000 }, () => {
  it('retains partial checkpoints, selects immutable saved input, and reuses keys with fresh deadlines', async () => {
    const f = await fixture([planned,
      { inputTokens: 10, result: response('propose_changes', { changes: [{ path, expectedHash: null, newText: 'Retained partial answer' }] }) },
      { inputTokens: 10, result: new ModelAdapterError('provider_error', 'Private provider failure', false, 500, { status: 'reported', totalTokens: 20 }) },
      { inputTokens: 10, result: response('read_file', { source: 'saved', savedOutputId: randomUUID(), path }) },
      { inputTokens: 10, result: async () => {
        const previous = f.adapter.calls.at(-1)!.request.messages.at(-1);
        if (previous?.role !== 'tool') throw new Error('Missing rejected read');
        expect(previous.results[0]!.result).toEqual({ error: { code: 'scope_violation' } });
        const prompt = f.adapter.calls.at(-1)!.request.messages[0];
        if (prompt?.role !== 'user') throw new Error('Missing prompt');
        const selected = JSON.parse(prompt.text).selectedSources.savedOutputs[0];
        return response('read_file', { source: 'saved', savedOutputId: selected.id, path });
      } },
      { inputTokens: 10, result: async () => {
        const result = f.adapter.calls.at(-1)!.request.messages.at(-1);
        if (result?.role !== 'tool') throw new Error('Missing read');
        expect(result.results[0]!.result.text).toBe('Retained partial answer');
        return done();
      } },
    ]);
    const first = await f.start(); expect((await settled(first.run.id)).status).toBe('incomplete');
    const old = (await agents(first.run.id)).find((a) => a.agent_key === 'writer')!;
    expect(old.status).toBe('failed'); expect(old.result_sha).not.toBeNull();
    const choices = await f.tasks.savedOutputs(f.workspaceId, f.task.id);
    expect(choices).toEqual([{ agentInstanceId: old.id, runId: first.run.id, commitSha: old.result_sha, path }]);
    await f.tasks.revise(f.workspaceId, f.task.id, { expectedVersion: 1, outcome: 'New requirement' });
    const live = await f.git.checkpoint({ workspaceId: f.workspaceId, taskId: f.task.id, files: [{ path: 'documents/current.md', text: 'Current human draft' }] });
    clock += 1000;
    const next = await f.retry([{ agentInstanceId: old.id, path }]); expect((await settled(next.run.id)).status).toBe('completed');
    const fresh = (await agents(next.run.id)).find((a) => a.agent_key === 'writer')!;
    expect(fresh.id).not.toBe(old.id); expect(fresh.deadline_at!.getTime()).toBe(clock + AGENT_TIMEOUT_MS);
    expect(fresh.started_at!.getTime()).toBeGreaterThan(old.started_at!.getTime());
    expect((await run(next.run.id)).task_version).toBe(2);
    expect((await run(next.run.id)).input_snapshot_sha).toBe(live.commitSha);
    const budget = await db.db.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', f.task.id).where('agent_key', '=', 'writer').executeTakeFirstOrThrow();
    expect(budget.consumed_tokens).toBe(420);
    expect(f.adapter.calls.filter((call) => call.request.preset === 'orchestrator')).toHaveLength(1);
    expect((await f.git.readText({ workspaceId: f.workspaceId, target: { kind: 'commit', commitSha: old.result_sha! }, path, allowedPaths: [path] })).text).toBe('Retained partial answer');
    const events = await db.db.selectFrom('task_events').select('payload').where('task_id', '=', f.task.id).execute();
    expect(JSON.stringify(events)).not.toContain('Private provider failure');
  });

  it('keeps unknown reservations across retry and settles late billing without accepting old effects', async () => {
    const f = await fixture([planned, { inputTokens: 10, result: new ModelAdapterError('provider_error', 'Uncertain', false) },
      { inputTokens: 10, result: done() }]);
    const first = await f.start(); await settled(first.run.id);
    const old = (await agents(first.run.id)).find((a) => a.agent_key === 'writer')!;
    const second = await f.retry(); await settled(second.run.id);
    expect((await agents(second.run.id)).find((a) => a.agent_key === 'writer')!.status).toBe('token_exhausted');
    expect(f.adapter.calls).toHaveLength(2);
    const call = await db.db.selectFrom('model_calls').selectAll().where('agent_id', '=', old.id).executeTakeFirstOrThrow();
    await expect(f.ledger.withActiveWrite(old.id, async () => {})).rejects.toBeDefined();
    await f.ledger.recordUsage({ agentInstanceId: old.id, requestKey: call.request_key, usage: { status: 'reported', totalTokens: 40 } });
    const third = await f.retry(); expect((await settled(third.run.id)).status).toBe('completed');
    const budget = await db.db.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', f.task.id).where('agent_key', '=', 'writer').executeTakeFirstOrThrow();
    expect(budget).toMatchObject({ consumed_tokens: 140, reserved_tokens: 0 });
  });

  it('times out a late result, retains its usage, and grants only the manual retry a fresh clock', async () => {
    const f = await fixture([planned, { inputTokens: 10, result: async () => { clock += AGENT_TIMEOUT_MS + 1; return done(); } },
      { inputTokens: 10, result: done() }]);
    const first = await f.start(); await settled(first.run.id);
    const old = (await agents(first.run.id)).find((a) => a.agent_key === 'writer')!;
    expect(old.status).toBe('timed_out'); expect(old.result_sha).toBeNull();
    const second = await f.retry(); expect((await settled(second.run.id)).status).toBe('completed');
    expect((await agents(second.run.id)).find((a) => a.agent_key === 'writer')!.deadline_at!.getTime()).toBe(clock + AGENT_TIMEOUT_MS);
  });

  it('cancels promptly when a provider ignores abort, and accounts its late result after retry', async () => {
    let release!: (value: AgentResponse) => void;
    const f = await fixture([planned, { inputTokens: 10, result: () => new Promise((resolve) => { release = resolve; releaseProviders.push(() => resolve(done())); }) },
      { inputTokens: 10, result: done() }]);
    const first = await f.start();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 60000 });
    const old = (await agents(first.run.id)).find((a) => a.agent_key === 'writer')!;
    await f.tasks.cancel(f.workspaceId, f.task.id);
    // Unknown in-flight usage cannot be spent again, even in a fresh attempt.
    const second = await f.retry(); await settled(second.run.id);
    expect((await agents(second.run.id)).find((a) => a.agent_key === 'writer')!.status).toBe('token_exhausted');
    release(done());
    await vi.waitFor(async () => {
      const budget = await db.db.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', f.task.id).where('agent_key', '=', 'writer').executeTakeFirstOrThrow();
      expect(budget).toMatchObject({ consumed_tokens: 100, reserved_tokens: 0 });
    });
    expect((await agents(first.run.id)).find((a) => a.id === old.id)).toMatchObject({ status: 'canceled', result_sha: null });
  });

  it('validates saved-output scope and versions before creating a run, and coalesces concurrent retry keys', async () => {
    const f = await fixture([planned, ...Array.from({ length: 4 }, () => ({ inputTokens: 10, result: done() }))]);
    const first = await f.start(); await settled(first.run.id);
    await expect(f.tasks.retry(f.workspaceId, f.task.id, { clientRequestId: randomUUID(), expectedVersion: 9 })).rejects.toMatchObject({ code: 'TASK_VERSION_CHANGED' });
    await expect(f.retry([{ agentInstanceId: randomUUID(), path }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(retryTaskRequestSchema.safeParse({ clientRequestId: randomUUID(), savedOutputs: [{ agentInstanceId: randomUUID(), path, commitSha: 'a'.repeat(40) }] }).success).toBe(false);
    for (let round = 0; round < 3; round++) {
      const clientRequestId = randomUUID();
      const results = await Promise.all(Array.from({ length: 8 }, () => f.tasks.retry(f.workspaceId, f.task.id, { clientRequestId })));
      expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      await settled(results[0]!.run.id);
      expect(f.adapter.calls).toHaveLength(3 + round);
      // A later replay must still return this attempt even with new selections.
      const replay = await f.tasks.retry(f.workspaceId, f.task.id, { clientRequestId, savedOutputs: [{ agentInstanceId: randomUUID(), path }] });
      expect(replay).toMatchObject({ idempotentReplay: true, run: { id: results[0]!.run.id } });
    }
  });

  it('does not launch scopes when shutdown begins during context capture', async () => {
    const f = await fixture([]);
    const capture = StartCapture.prototype.capture;
    let reachedCapture = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(StartCapture.prototype, 'capture').mockImplementation(async function (this: StartCapture, ...args) {
      const result = await capture.apply(this, args);
      reachedCapture = true;
      await gate;
      return result;
    });
    try {
      const first = await f.start();
      await vi.waitFor(() => expect(reachedCapture).toBe(true), { timeout: 60000 });
      const closing = orchestrator!.close();
      release();
      await closing;
      expect(f.adapter.calls).toHaveLength(0);
      expect(await agents(first.run.id)).toEqual([]);
      expect((await run(first.run.id)).status).toBe('planning');
    } finally { release(); spy.mockRestore(); }
  });

  it('accepts explicit retry after the existing D08 recovery seam marks a prior boot interrupted', async () => {
    const f = await fixture([planned, { inputTokens: 10, result: done() }]);
    const recorder = new PgTaskService({ db: db.db, bootId: randomUUID(), orchestration: { onRunCreated() {}, onCancelRequested() {} } });
    const first = await recorder.start(f.workspaceId, f.task.id, { expectedVersion: 1, clientRequestId: randomUUID() });
    await new PgRunStore({ db: db.db, bootId: BOOT_ID }).markInterruptedFromPreviousBoots();
    expect((await run(first.run.id)).status).toBe('interrupted');
    const second = await f.retry(); expect((await settled(second.run.id)).status).toBe('completed');
  });
});
