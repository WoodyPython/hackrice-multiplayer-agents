import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGENT_TIMEOUT_MS, eventKeys, type AgentPlan, type PlanningContext } from '@app/contracts';
import { PgAgentLedger } from '../src/agents/index.js';
import { OrchestratorPlanner, PgPlanStore } from '../src/orchestration/index.js';
import { FakeModelAdapter, ModelAdapterError, type AgentResponse } from '../src/models/index.js';
import type { DbHandle } from '../src/db/client.js';
import { PgRunStore } from '../src/runs/run-store.js';
import { BOOT_ID, connectTestDb, insertWorkspace, insertTask, insertRun } from './helpers.js';

let handle: DbHandle;
let workspaceId: string;
let clock = Date.now();
let ledger: PgAgentLedger;
const errors: unknown[] = [];
const validPlan: AgentPlan = { summary: 'Write and review an FAQ', assignments: [
  { id: 'facts', preset: 'analyst', dependsOn: [], writePaths: [], instruction: 'Return confirmed facts and source references.' },
  { id: 'faq', preset: 'writer', dependsOn: ['facts'], writePaths: ['documents/faq.md'], instruction: 'Return FAQ text and limitations.' },
  { id: 'review', preset: 'reviewer', dependsOn: ['faq'], writePaths: [], instruction: 'Compare the FAQ with the criteria and sources.' },
] };
const response = (value: unknown = validPlan): AgentResponse => ({
  text: JSON.stringify(value), toolCalls: [], finishReason: 'STOP', usage: { status: 'reported', totalTokens: 100 },
  providerState: { provider: 'fixture', content: { parts: [{ thoughtSignature: 'keep-me' }] } },
});
beforeAll(async () => {
  handle = connectTestDb(); workspaceId = await insertWorkspace(handle.db, 'C03');
  ledger = new PgAgentLedger({ db: handle.db, bootId: BOOT_ID, now: () => new Date(clock) });
});
afterEach(() => { vi.restoreAllMocks(); expect(errors.splice(0)).toEqual([]); });
afterAll(async () => { await handle.close(); });

async function fixture() {
  const taskId = await insertTask(handle.db, workspaceId, { status: 'planning' });
  const runId = await insertRun(handle.db, workspaceId, taskId, { discussion_cutoff_seq: 2 });
  await handle.db.updateTable('tasks').set({ active_run_id: runId }).where('id', '=', taskId).execute();
  const context: PlanningContext = {
    task: { id: taskId, version: 1, title: 'Launch FAQ', outcome: 'Explain the launch', criteria: ['Cite evidence'], outputPaths: ['documents/faq.md'] },
    guidance: 'Use confirmed facts.',
    manifest: { taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 2, materials: [],
      approvedPaths: [], approvedCommitSha: 'a'.repeat(40), draftCheckpointSha: null, draftFileHashes: {} },
    discussion: [{ seq: 1, body: 'For new contributors.' }, { seq: 2, body: 'Keep it concise.' }], sources: [],
  };
  await handle.db.updateTable('runs').set({ input_snapshot_sha: 'a'.repeat(40), context_manifest: context.manifest })
    .where('id', '=', runId).execute();
  const agent = await ledger.createInstance({ runId, agentKey: 'orchestrator', assignmentKey: 'orchestrator', preset: 'orchestrator', modelId: 'fake' });
  return { runId, taskId, agentInstanceId: agent.id, context };
}
function planner(adapter: FakeModelAdapter) {
  return new OrchestratorPlanner({ db: handle.db, ledger, adapter, bootId: BOOT_ID,
    now: () => clock, onBackgroundError: (e) => { errors.push(e); } });
}
async function artifacts(agentId: string) {
  return handle.db.selectFrom('task_events').selectAll()
    .where('event_key', '=', eventKeys.agentSettled(agentId, 'completed')).execute();
}
async function agentStatus(agentId: string) {
  return (await handle.db.selectFrom('agent_instances').select('status').where('id', '=', agentId).executeTakeFirstOrThrow()).status;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('orchestrator planning with real persistence and budget accounting', () => {
  it('hands the validated graph to B07 dependency linking without starting workers', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response() }]);
    const accepted = await planner(adapter).plan(f);
    const runs = new PgRunStore({ db: handle.db, bootId: BOOT_ID });
    for (const assignment of accepted.assignments) {
      await ledger.createInstance({ runId: f.runId, agentKey: assignment.id, assignmentKey: assignment.id,
        preset: assignment.preset, modelId: 'fake', instruction: assignment.instruction, writePaths: assignment.writePaths });
    }
    await runs.linkDependencies(f.runId, accepted);
    const ready = await runs.readyInstances(f.runId);
    expect(ready.map((a) => a.assignmentKey)).toEqual(['facts']);
    expect(ready[0]).toMatchObject({ startedAt: null, deadlineAt: null, status: 'pending' });
    expect(await handle.db.selectFrom('agent_dependencies').selectAll().where('run_id', '=', f.runId).execute()).toHaveLength(2);
    expect(await handle.db.selectFrom('task_agent_budgets').select('agent_key').where('task_id', '=', f.taskId).execute()).toHaveLength(4);
  });

  it('counts captured inputs, stores a complete plan, and leaves worker dispatch to the coordinator', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response() }]);
    const service = planner(adapter);
    expect(await service.plan(f)).toEqual(validPlan);
    expect(adapter.counts[0]).toEqual(adapter.calls[0]!.request);
    expect(adapter.calls[0]!.request).toMatchObject({ preset: 'orchestrator' });
    expect(adapter.calls[0]!.request.tools).toBeUndefined();
    expect(JSON.parse((adapter.calls[0]!.request.messages[0] as { text: string }).text).capturedContext).toEqual(f.context);
    expect(await agentStatus(f.agentInstanceId)).toBe('completed');
    const events = await artifacts(f.agentInstanceId);
    expect(events).toHaveLength(1); expect(events[0]!.payload.plan).toEqual(validPlan);
    expect(await handle.db.selectFrom('agent_instances').select('id').where('run_id', '=', f.runId).execute()).toHaveLength(1);
    expect(await handle.db.selectFrom('agent_dependencies').selectAll().where('run_id', '=', f.runId).execute()).toHaveLength(0);
    expect(await handle.db.selectFrom('task_agent_budgets').select(['consumed_tokens', 'reserved_tokens'])
      .where('task_id', '=', f.taskId).executeTakeFirstOrThrow()).toEqual({ consumed_tokens: 100, reserved_tokens: 0 });
  });

  it('coalesces concurrent planning and replays the saved plan without another model call', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response() }]);
    const service = planner(adapter);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => service.plan(f)));
    expect(outcomes.every((x) => x.summary === validPlan.summary)).toBe(true);
    expect(await planner(adapter).plan(f)).toEqual(validPlan);
    expect(adapter.calls).toHaveLength(1); expect(await artifacts(f.agentInstanceId)).toHaveLength(1);
  });

  it('repairs multiple invalid plans with the same instance and preserved protocol history', async () => {
    const f = await fixture();
    const cyclic = structuredClone(validPlan); cyclic.assignments[0]!.dependsOn = ['faq'];
    const bad = [response({ wrong: true }), response(cyclic), { ...response(), text: 'not json' }];
    const adapter = new FakeModelAdapter([...bad, response()].map((value) => ({ inputTokens: 20, result: value })));
    const service = planner(adapter);
    expect(await service.plan(f)).toEqual(validPlan);
    expect(adapter.calls).toHaveLength(4);
    const followup = adapter.calls[1]!.request.messages;
    expect(followup[1]).toEqual({ role: 'assistant', response: bad[0] });
    expect(JSON.parse((followup[2] as { text: string }).text)).toHaveProperty('validationErrors');
    expect(adapter.calls[3]!.request.messages).toHaveLength(7);
    expect(await handle.db.selectFrom('model_calls').select('id').where('agent_id', '=', f.agentInstanceId).execute()).toHaveLength(4);
    const row = await handle.db.selectFrom('agent_instances').select(['started_at', 'deadline_at'])
      .where('id', '=', f.agentInstanceId).executeTakeFirstOrThrow();
    expect(new Date(row.deadline_at!).getTime() - new Date(row.started_at!).getTime()).toBe(AGENT_TIMEOUT_MS);
  });

  it('never treats parseable but truncated JSON as an accepted plan', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([
      { inputTokens: 20, result: { ...response(), finishReason: 'MAX_TOKENS' } }, { inputTokens: 20, result: response() },
    ]);
    await planner(adapter).plan(f);
    expect(adapter.calls).toHaveLength(2); expect(await artifacts(f.agentInstanceId)).toHaveLength(1);
  });

  it.each(['blocked', 'tools', 'fatal'] as const)('stops on %s responses without accepting or executing a plan', async (kind) => {
    const f = await fixture();
    const value = kind === 'blocked' ? { ...response(), blockReason: 'SAFETY' }
      : kind === 'tools' ? { ...response(), toolCalls: [{ name: 'run_shell', arguments: { command: 'echo forbidden' } }] }
      : new ModelAdapterError('configuration', 'Invalid configuration');
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: value }]);
    await expect(planner(adapter).plan(f)).rejects.toBeDefined();
    expect(await artifacts(f.agentInstanceId)).toHaveLength(0); expect(await agentStatus(f.agentInstanceId)).toBe('failed');
    expect(adapter.calls).toHaveLength(1);
  });

  it('retries a reported transient error with backoff, fresh request keys and the same ledger', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([
      { inputTokens: 20, result: new ModelAdapterError('rate_limited', 'Retry later', true, 429, { status: 'reported', totalTokens: 25 }) },
      { inputTokens: 20, result: response() },
    ]);
    await planner(adapter).plan(f);
    const calls = await handle.db.selectFrom('model_calls').select('request_key').where('agent_id', '=', f.agentInstanceId).execute();
    expect(calls).toHaveLength(2); expect(new Set(calls.map((c) => c.request_key)).size).toBe(2);
    expect((await handle.db.selectFrom('task_agent_budgets').select('consumed_tokens').where('task_id', '=', f.taskId).executeTakeFirstOrThrow()).consumed_tokens).toBe(125);
  });

  it('stops repairs when the cumulative task-agent budget is exhausted', async () => {
    const f = await fixture(); const bad = { ...response({ invalid: true }), usage: { status: 'reported' as const, totalTokens: 64000 } };
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: bad }, { inputTokens: 20, result: response() }]);
    await expect(planner(adapter).plan(f)).rejects.toMatchObject({ code: 'token_exhausted' });
    expect(adapter.calls).toHaveLength(1); expect(await agentStatus(f.agentInstanceId)).toBe('token_exhausted');
    expect(await artifacts(f.agentInstanceId)).toHaveLength(0);
  });

  it('retains late usage while rejecting a plan at the deadline', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: async () => {
      clock += AGENT_TIMEOUT_MS; return response();
    } }]);
    await expect(planner(adapter).plan(f)).rejects.toMatchObject({ code: 'timed_out' });
    expect(await agentStatus(f.agentInstanceId)).toBe('timed_out'); expect(await artifacts(f.agentInstanceId)).toHaveLength(0);
    expect((await handle.db.selectFrom('task_agent_budgets').select('consumed_tokens').where('task_id', '=', f.taskId).executeTakeFirstOrThrow()).consumed_tokens).toBe(100);
  });

  it('does not store a response after run cancellation', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: async () => {
      await handle.db.updateTable('runs').set({ status: 'canceled' }).where('id', '=', f.runId).execute();
      return response();
    } }]);
    await expect(planner(adapter).plan(f)).rejects.toMatchObject({ code: 'inactive' });
    expect(await artifacts(f.agentInstanceId)).toHaveLength(0);
  });

  it('supports immediate local cancellation before a scope has opened', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response() }]);
    const service = planner(adapter); const pending = service.plan(f);
    service.cancel(f.agentInstanceId);
    await expect(pending).rejects.toMatchObject({ code: 'canceled' });
    expect(adapter.calls).toHaveLength(0); expect(await artifacts(f.agentInstanceId)).toHaveLength(0);
  });

  it('cancels an in-flight provider request and still records a late response', async () => {
    const f = await fixture(); const sent = deferred<void>(); const late = deferred<AgentResponse>();
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: async () => { sent.resolve(); return late.promise; } }]);
    const service = planner(adapter); const pending = service.plan(f);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'canceled' });
    await sent.promise; service.cancel(f.agentInstanceId); await rejected;
    late.resolve(response());
    await vi.waitFor(async () => {
      expect((await handle.db.selectFrom('task_agent_budgets').select('consumed_tokens').where('task_id', '=', f.taskId).executeTakeFirstOrThrow()).consumed_tokens).toBe(100);
    });
    expect(await artifacts(f.agentInstanceId)).toHaveLength(0);
  });

  it('rejects changed, missing or unselected context before making model calls', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response() }]);
    for (const modify of [
      (c: PlanningContext) => { c.task.version = 2; },
      (c: PlanningContext) => { c.task.id = randomUUID(); },
      (c: PlanningContext) => { c.manifest.guidanceVersion = 2; },
      (c: PlanningContext) => { c.discussion.push({ seq: 3, body: 'After cutoff' }); },
      (c: PlanningContext) => { c.sources.push({ kind: 'approved', path: 'documents/unselected.md', text: 'Not selected' }); },
      (c: PlanningContext) => { c.manifest.materials.push({ materialId: randomUUID(), sha256: 'missing' }); },
    ]) {
      const context = structuredClone(f.context); modify(context);
      await expect(planner(adapter).plan({ ...f, context })).rejects.toMatchObject({ code: 'context_mismatch' });
    }
    await handle.db.updateTable('runs').set({ input_snapshot_sha: null }).where('id', '=', f.runId).execute();
    await expect(planner(adapter).plan(f)).rejects.toMatchObject({ code: 'snapshot_not_ready' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('preserves selected sources and frozen task content even if live requirements change', async () => {
    const f = await fixture(); const materialId = randomUUID();
    f.context.manifest.materials = [{ materialId, sha256: 'captured-hash' }];
    f.context.sources = [{ kind: 'material', materialId, sha256: 'captured-hash', text: 'Captured source text' }];
    await handle.db.updateTable('runs').set({ context_manifest: f.context.manifest }).where('id', '=', f.runId).execute();
    await handle.db.updateTable('tasks').set({ title: 'Changed live title', version: 2 }).where('id', '=', f.taskId).execute();
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response() }]);
    const pending = planner(adapter).plan(f);
    f.context.task.title = 'Mutated caller title';
    await pending;
    const body = (adapter.calls[0]!.request.messages[0] as { text: string }).text;
    expect(body).toContain('Captured source text'); expect(body).toContain('Launch FAQ');
    expect(body).not.toContain('Changed live title'); expect(body).not.toContain('Mutated caller title');
  });

  it('rejects invalid plans again at the storage boundary and rolls back completion crossing the deadline', async () => {
    const f = await fixture(); await ledger.start(f.agentInstanceId);
    const store = new PgPlanStore({ db: handle.db, ledger, bootId: BOOT_ID, now: () => new Date(clock) });
    const snapshot = { inputSnapshotSha: 'a'.repeat(40), manifest: f.context.manifest };
    await expect(store.save(f.agentInstanceId, f.runId, 'digest', { invalid: true }, snapshot)).rejects.toMatchObject({ code: 'invalid_plan' });
    const crossing = new PgPlanStore({ db: handle.db, ledger, bootId: BOOT_ID, now: () => { clock += AGENT_TIMEOUT_MS; return new Date(clock); } });
    await expect(crossing.save(f.agentInstanceId, f.runId, 'digest', validPlan, snapshot)).rejects.toMatchObject({ code: 'timed_out' });
    expect(await artifacts(f.agentInstanceId)).toHaveLength(0); expect(await agentStatus(f.agentInstanceId)).toBe('timed_out');
  });

  it.each(['snapshot', 'manifest'] as const)('refuses to complete if captured %s identity changes during generation', async (kind) => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: async () => {
      await handle.db.updateTable('runs').set(kind === 'snapshot'
        ? { input_snapshot_sha: 'b'.repeat(40) }
        : { context_manifest: { ...f.context.manifest, guidanceVersion: 2 } }).where('id', '=', f.runId).execute();
      return response();
    } }]);
    await expect(planner(adapter).plan(f)).rejects.toMatchObject({ code: 'context_mismatch' });
    expect(await artifacts(f.agentInstanceId)).toHaveLength(0);
  });
});
