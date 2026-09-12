import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TIMEOUT_MS, type AgentPreset, type GuardedWorkerGitService, type Material,
  type PlanningContext, type WorkerFinish } from '@app/contracts';
import { PgAgentLedger } from '../src/agents/index.js';
import { PgWorkerStore, WorkerTools, WorkerExecutor, WORKER_TOOLS } from '../src/workers/index.js';
import { FakeModelAdapter, ModelAdapterError, type AgentResponse, type ToolCall } from '../src/models/index.js';
import { LocalGitService } from '../src/git/service.js';
import { PgDiscussionService } from '../src/discussion/service.js';
import { blobHash } from '../src/git/files.js';
import type { DbHandle } from '../src/db/client.js';
import { BOOT_ID, connectTestDb, insertWorkspace, insertTask, insertRun } from './helpers.js';

let db: DbHandle, root: string, git: LocalGitService, workspaceId: string, base: string;
let clock: number, ledger: PgAgentLedger, store: PgWorkerStore;
const errors: unknown[] = [];
const materials = { readSelected: vi.fn<(_: string, id: string) => Promise<{ material: Material; bytes: Uint8Array }>>() };
const path = 'documents/guide.md';
const finish = (overrides: Partial<WorkerFinish> = {}): WorkerFinish => ({ summary: 'Done', references: [], limitations: [], outputPaths: [], ...overrides });
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: randomUUID(), name, arguments: args });
const response = (...toolCalls: ToolCall[]): AgentResponse => ({ toolCalls, finishReason: 'STOP', usage: { status: 'reported', totalTokens: 100 },
  providerState: { parts: [{ thoughtSignature: 'preserve-tool-signature' }] } });
const done = () => response(call('finish_assignment', finish()));
beforeAll(async () => {
  db = connectTestDb(); root = await mkdtemp(join(tmpdir(), 'c04-workers-')); git = new LocalGitService(join(root, 'git'));
  workspaceId = await insertWorkspace(db.db, 'C04 workers');
  const taskId = await insertTask(db.db, workspaceId);
  base = (await git.checkpoint({ workspaceId, taskId, files: [{ path, text: 'Original source' }] })).commitSha;
});
beforeEach(() => {
  clock = Date.now(); ledger = new PgAgentLedger({ db: db.db, bootId: BOOT_ID, now: () => new Date(clock) });
  store = new PgWorkerStore(db.db, ledger, () => new Date(clock)); materials.readSelected.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); expect(errors.splice(0)).toEqual([]); });
afterAll(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });

async function fixture(preset: AgentPreset = 'writer', worker = false) {
  const taskId = await insertTask(db.db, workspaceId, { status: 'working' });
  const runId = await insertRun(db.db, workspaceId, taskId, { status: 'working' });
  await db.db.updateTable('tasks').set({ active_run_id: runId }).where('id', '=', taskId).execute();
  const context: PlanningContext = { task: { id: taskId, version: 1, title: 'Guide', outcome: 'Explain', criteria: [], outputPaths: [path] },
    guidance: 'Cite sources', discussion: [], sources: [], manifest: {
      taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [], approvedPaths: [path],
      approvedCommitSha: base, draftCheckpointSha: base, draftFileHashes: { [path]: blobHash(Buffer.from('Original source')) },
    } };
  await db.db.updateTable('runs').set({ input_snapshot_sha: base, context_manifest: context.manifest }).where('id', '=', runId).execute();
  const agent = await ledger.createInstance({ runId, agentKey: 'worker', assignmentKey: 'worker', preset, modelId: 'fake',
    instruction: 'Write a guide', writePaths: ['writer', 'coder'].includes(preset) ? [path, 'code/example.ts'] : [] });
  await db.db.updateTable('agent_instances').set({ base_sha: base }).where('id', '=', agent.id).execute();
  if (worker) await git.createWorker({ workspaceId, agentInstanceId: agent.id, baseSha: base });
  return { taskId, runId, agentInstanceId: agent.id, context };
}
async function session(f: Awaited<ReturnType<typeof fixture>>, service: GuardedWorkerGitService = git) {
  await ledger.start(f.agentInstanceId);
  const binding = await store.bind(f.agentInstanceId, f.context);
  const tools = new WorkerTools({ store, git: service, materials, binding });
  const controller = new AbortController();
  return { tools, controller, invoke: (name: string, args: Record<string, unknown>) => tools.invoke(call(name, args), controller.signal) };
}
function executor(adapter: FakeModelAdapter, service: GuardedWorkerGitService = git,
  wait?: (ms: number, signal: AbortSignal) => Promise<void>) {
  return new WorkerExecutor({ db: db.db, ledger, adapter, git: service, materials,
    now: () => clock, wait, onBackgroundError: (error) => errors.push(error) });
}
async function state(id: string) { return db.db.selectFrom('agent_instances').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); }
async function events(id: string, type: string) {
  const agent = await state(id);
  return db.db.selectFrom('task_events').selectAll().where('run_id', '=', agent.run_id).where('type', '=', type).execute();
}

describe('worker tools and immutable references', () => {
  it('exposes exactly the five tools with no runtime authority arguments', () => {
    expect(WORKER_TOOLS.map((tool) => tool.name)).toEqual(['read_file', 'read_material', 'propose_changes', 'ask_question', 'finish_assignment']);
    for (const tool of WORKER_TOOLS) expect(JSON.stringify(tool.parameters)).not.toMatch(/agentInstanceId|workspaceId|worktreePath|allowedPaths|command/);
  });

  it.each([
    ['run_shell', { command: 'echo forbidden' }],
    ['read_file', { path, source: 'worker', agentInstanceId: randomUUID() }],
    ['read_file', { path, source: 'worker', allowedPaths: [path] }],
    ['propose_changes', { changes: [{ path, newText: 'Missing hash' }] }],
    ['ask_question', { body: 'Why?', deadline: 1000 }],
  ])('rejects unknown tools or extra authority fields: %s', async (name, args) => {
    const f = await fixture(); const s = await session(f);
    await expect(s.invoke(name as string, args as Record<string, unknown>)).rejects.toMatchObject({ code: 'invalid_tool_arguments' });
  });

  it.each(['../secret.txt', 'documents/unselected.md', 'documents/Guide.md', 'documents\\guide.md'])('refuses unselected/noncanonical reads: %s', async (bad) => {
    const s = await session(await fixture());
    await expect(s.invoke('read_file', { path: bad, source: 'approved' })).rejects.toBeDefined();
  });

  it('reads captured approved/draft versions and completes a readonly assignment without a worktree', async () => {
    const f = await fixture('analyst'); const s = await session(f);
    const read = await s.invoke('read_file', { path, source: 'approved' });
    expect(read.text).toBe('Original source');
    const ref = read.reference as { id: string; commitSha: string };
    expect(ref.commitSha).toBe(base);
    expect((await s.invoke('read_file', { path, source: 'draft' })).text).toBe('Original source');
    expect((await s.invoke('read_file', { path, source: 'worker' })).text).toBe('Original source');
    const result = await s.tools.finish(finish({ references: [ref.id] }), s.controller.signal);
    expect(result.references).toHaveLength(1); expect(result.artifacts).toEqual([]);
    expect((await state(f.agentInstanceId)).status).toBe('completed');
  });

  it('rejects invented citations and uncheckpointed artifact claims', async () => {
    const s = await session(await fixture());
    await expect(s.tools.finish(finish({ references: ['invented'] }), s.controller.signal)).rejects.toMatchObject({ code: 'unknown_reference' });
    await expect(s.tools.finish(finish({ outputPaths: [path] }), s.controller.signal)).rejects.toMatchObject({ code: 'invalid_artifacts' });
  });

  it('authorizes materials by captured membership and checks the actual immutable bytes', async () => {
    const f = await fixture(); const materialId = randomUUID(), bytes = Buffer.from('Selected evidence');
    const hash = createHash('sha256').update(bytes).digest('hex');
    f.context.manifest.materials = [{ materialId, sha256: hash }];
    await db.db.updateTable('runs').set({ context_manifest: f.context.manifest }).where('id', '=', f.runId).execute();
    materials.readSelected.mockResolvedValue({ bytes, material: { id: materialId, workspaceId, filename: 'evidence.txt', sha256: hash,
      byteSize: bytes.length, contentType: 'text/plain', guestLabel: null, createdAt: new Date().toISOString(), deletedAt: null } });
    const s = await session(f);
    await expect(s.invoke('read_material', { materialId: randomUUID() })).rejects.toMatchObject({ code: 'scope_violation' });
    expect(materials.readSelected).not.toHaveBeenCalled();
    const result = await s.invoke('read_material', { materialId }); expect(result.text).toBe('Selected evidence');
    const source = await materials.readSelected(workspaceId, materialId);
    materials.readSelected.mockResolvedValue({ ...source, bytes: Buffer.from('Changed') });
    await expect(s.invoke('read_material', { materialId })).rejects.toMatchObject({ code: 'source_changed' });
  });
});

describe('real Git checkpoints and execution guards', { timeout: 120_000 }, () => {
  it('atomically checkpoints replacements/creation/deletion, stores SHA and verifies completion artifacts', async () => {
    const f = await fixture('writer', true); const s = await session(f);
    const original = await s.invoke('read_file', { path, source: 'worker' });
    const first = await s.invoke('propose_changes', { changes: [{ path, expectedHash: original.hash, newText: 'Updated' },
      { path: 'code/example.ts', expectedHash: null, newText: 'export const answer = 42;' }] });
    expect((await state(f.agentInstanceId)).result_sha).toBe(first.commitSha);
    const updated = await s.invoke('read_file', { path, source: 'worker' });
    await expect(s.invoke('propose_changes', { changes: [{ path, expectedHash: original.hash, newText: 'Stale' },
      { path: 'code/example.ts', expectedHash: blobHash(Buffer.from('export const answer = 42;')), newText: null }] })).rejects.toMatchObject({ code: 'FILE_VERSION_CHANGED' });
    expect((await s.invoke('read_file', { path: 'code/example.ts', source: 'worker' })).text).toBe('export const answer = 42;');
    await s.invoke('propose_changes', { changes: [{ path, expectedHash: updated.hash, newText: null }] });
    await expect(s.tools.finish(finish({ outputPaths: [path] }), s.controller.signal)).rejects.toMatchObject({ code: 'invalid_artifacts' });
    const result = await s.tools.finish(finish({ outputPaths: [path, 'code/example.ts'] }), s.controller.signal);
    expect(result.artifacts).toContainEqual({ path, hash: null });
    expect((await events(f.agentInstanceId, 'agent.checkpointed'))).toHaveLength(2);
    expect((await events(f.agentInstanceId, 'agent.completed'))[0]?.payload.result).toEqual(result);
    expect((await git.readText({ workspaceId, target: { kind: 'commit', commitSha: base }, path, allowedPaths: [path] })).text).toBe('Original source');
  });

  it.each(['analyst', 'reviewer'] as const)('keeps %s readonly', async (preset) => {
    const s = await session(await fixture(preset));
    await expect(s.invoke('propose_changes', { changes: [{ path, expectedHash: null, newText: 'Unauthorized' }] })).rejects.toMatchObject({ code: 'scope_violation' });
  });

  it('rejects expansion and duplicate paths before calling Git', async () => {
    const s = await session(await fixture()); const spy = vi.spyOn(git, 'applyGuardedWorkerChanges');
    await expect(s.invoke('propose_changes', { changes: [{ path: 'documents/other.md', expectedHash: null, newText: 'No' }] })).rejects.toMatchObject({ code: 'scope_violation' });
    const change = { path, expectedHash: null, newText: 'No' };
    await expect(s.invoke('propose_changes', { changes: [change, change] })).rejects.toMatchObject({ code: 'duplicate_path' });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'cancel', 'boot', 'supersede', 'signal'] as const)('rejects %s after candidate preparation but before publishing the ref', async (kind) => {
    const f = await fixture('writer', true); let controller: AbortController;
    const service: GuardedWorkerGitService = { readText: (input) => git.readText(input),
      applyGuardedWorkerChanges: (input, guard) => git.applyGuardedWorkerChanges(input, async (checkpoint, publish) => {
        if (kind === 'timeout') clock += AGENT_TIMEOUT_MS + 1;
        if (kind === 'cancel') await db.db.updateTable('runs').set({ status: 'canceled' }).where('id', '=', f.runId).execute();
        if (kind === 'boot') await db.db.updateTable('runs').set({ boot_id: randomUUID() }).where('id', '=', f.runId).execute();
        if (kind === 'supersede') await db.db.updateTable('tasks').set({ active_run_id: null }).where('id', '=', f.taskId).execute();
        if (kind === 'signal') controller.abort();
        await guard(checkpoint, publish);
      }) };
    const s = await session(f, service); controller = s.controller;
    await expect(s.invoke('propose_changes', { changes: [{ path, expectedHash: blobHash(Buffer.from('Original source')), newText: 'Late' }] })).rejects.toBeDefined();
    expect((await git.readText({ workspaceId, target: { kind: 'worker', agentInstanceId: f.agentInstanceId }, path, allowedPaths: [path] })).text).toBe('Original source');
    expect((await events(f.agentInstanceId, 'agent.checkpointed'))).toHaveLength(0);
  });
});

describe('budgeted worker tool loop and human waits', () => {
  it('waits for dependencies before starting and includes readonly prerequisite results', async () => {
    const f = await fixture();
    const parent = await ledger.createInstance({ runId: f.runId, agentKey: 'research', assignmentKey: 'research', preset: 'analyst', modelId: 'fake' });
    await db.db.updateTable('agent_instances').set({ base_sha: base }).where('id', '=', parent.id).execute();
    await db.db.insertInto('agent_dependencies').values({ run_id: f.runId, agent_id: f.agentInstanceId, prerequisite_agent_id: parent.id }).execute();
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: done() }]); const service = executor(adapter);
    await expect(service.execute(f)).rejects.toMatchObject({ code: 'prerequisites_pending' });
    expect((await state(f.agentInstanceId)).started_at).toBeNull(); expect(adapter.calls).toHaveLength(0);
    await ledger.start(parent.id);
    await store.finish(parent.id, { summary: 'Research found an important limitation.', references: [], limitations: ['No external verification'],
      artifacts: [], resultSha: base }, new AbortController().signal);
    await service.execute(f);
    expect(adapter.calls[0]!.request.messages[0]).toMatchObject({ role: 'user', text: expect.stringContaining('Research found an important limitation.') });
  });

  it('repairs invalid tools, preserves signatures/tool IDs and coalesces duplicate dispatch', async () => {
    const f = await fixture(); const bad = call('run_shell', { command: 'forbidden' });
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response(bad) }, { inputTokens: 30, result: done() }]);
    const service = executor(adapter); const result = await Promise.all([service.execute(f), service.execute(f)]);
    expect(result[0]).toEqual(result[1]); expect(adapter.calls).toHaveLength(2);
    const messages = adapter.calls[1]!.request.messages;
    expect(messages[1]).toMatchObject({ role: 'assistant', response: { providerState: response().providerState } });
    expect(messages[2]).toMatchObject({ role: 'tool', results: [{ id: bad.id, name: bad.name, result: { error: { code: 'invalid_tool_arguments' } } }] });
    const budget = await db.db.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', f.taskId).executeTakeFirstOrThrow();
    expect(budget.consumed_tokens).toBe(200); expect(budget.reserved_tokens).toBe(0);
    await expect(service.execute(f)).rejects.toBeDefined(); expect(adapter.calls).toHaveLength(2);
  });

  it.each(['truncated', 'mixed', 'text'] as const)('does not accept %s output as completion', async (kind) => {
    const f = await fixture();
    const first = kind === 'truncated' ? { ...done(), finishReason: 'MAX_TOKENS' } : kind === 'mixed'
      ? response(call('ask_question', { body: 'Should not run' }), call('finish_assignment', finish())) : { ...response(), text: 'Done' };
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: first }, { inputTokens: 20, result: done() }]);
    await executor(adapter).execute(f); expect(adapter.calls).toHaveLength(2);
    expect(await events(f.agentInstanceId, 'agent.waiting')).toHaveLength(0);
  });

  it('retries a provider throttle on the same deadline and budget', async () => {
    const f = await fixture();
    const adapter = new FakeModelAdapter([{ inputTokens: 10, result: new ModelAdapterError('rate_limited', 'Retry', true, 429, { status: 'reported', totalTokens: 10 }) },
      { inputTokens: 20, result: done() }]);
    const wait = vi.fn(async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); });
    await executor(adapter, git, wait).execute(f);
    expect(wait).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    const agent = await state(f.agentInstanceId);
    expect(new Date(agent.deadline_at!).getTime() - new Date(agent.started_at!).getTime()).toBe(AGENT_TIMEOUT_MS);
    expect(adapter.calls).toHaveLength(2);
    const waiting = (await events(f.agentInstanceId, 'agent.waiting')).filter((event) => event.payload.reason === 'provider_backoff');
    expect(waiting.map((event) => event.payload.waiting)).toEqual([true, false]);
    expect(waiting[0]!.payload).toMatchObject({ agentId: f.agentInstanceId, delayMs: 1000,
      retryAt: new Date(clock + 1000).toISOString() });
    expect(waiting[1]!.payload.retryAt).toBeNull();
    expect((await events(f.agentInstanceId, 'agent.waiting')).some((event) => event.payload.questionId)).toBe(false);
  });

  it('waits for a B03 answer above the cutoff without refreshing the clock', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([
      { inputTokens: 20, result: response(call('ask_question', { body: 'Who is the audience?' })) }, { inputTokens: 20, result: done() },
    ]);
    const pending = executor(adapter).execute(f);
    let questionId = '';
    await vi.waitFor(async () => {
      const q = await db.db.selectFrom('agent_questions').selectAll().where('agent_instance_id', '=', f.agentInstanceId).executeTakeFirst();
      expect(q?.status).toBe('open'); questionId = q!.id;
    });
    const started = await state(f.agentInstanceId); expect(started.status).toBe('needs_input');
    await new PgDiscussionService({ db: db.db }).answer(workspaceId, f.taskId,
      { questionId, body: 'New contributors', guestLabel: 'Guest' });
    await pending;
    expect(JSON.stringify(adapter.calls[1]!.request.messages)).toContain('New contributors');
    expect((await state(f.agentInstanceId)).deadline_at).toEqual(started.deadline_at);
    const answer = await db.db.selectFrom('discussion_entries').select('seq').where('task_id', '=', f.taskId).where('actor_type', '=', 'guest').executeTakeFirstOrThrow();
    expect(answer.seq).toBeGreaterThan(f.context.manifest.discussionCutoffSeq);
  });

  it('expires a waiting question and never calls the provider again', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response(call('ask_question', { body: 'Why?' })) }]);
    const pending = executor(adapter).execute(f); const rejected = expect(pending).rejects.toMatchObject({ code: 'timed_out' });
    await vi.waitFor(async () => expect(await events(f.agentInstanceId, 'agent.waiting')).toHaveLength(1));
    clock += AGENT_TIMEOUT_MS + 1;
    await rejected; expect((await state(f.agentInstanceId)).status).toBe('timed_out');
    const q = await db.db.selectFrom('agent_questions').select('status').where('agent_instance_id', '=', f.agentInstanceId).executeTakeFirstOrThrow();
    expect(q.status).toBe('expired'); expect(adapter.calls).toHaveLength(1);
  });

  it('cancels a human wait without reporting a background timer failure', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: response(call('ask_question', { body: 'Why?' })) }]);
    const service = executor(adapter); const pending = service.execute(f);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'canceled' });
    await vi.waitFor(async () => expect(await events(f.agentInstanceId, 'agent.waiting')).toHaveLength(1));
    service.cancel(f.agentInstanceId); await rejected;
    // Let the underlying aborted tool settle after run()'s promise race.
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]); expect(adapter.calls).toHaveLength(1);
    expect(await events(f.agentInstanceId, 'agent.completed')).toHaveLength(0);
  });

  it('records blocked/fatal responses as failure rather than completion', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: { ...done(), blockReason: 'SAFETY' } }]);
    await expect(executor(adapter).execute(f)).rejects.toMatchObject({ code: 'blocked_response' });
    expect((await state(f.agentInstanceId)).status).toBe('failed'); expect(await events(f.agentInstanceId, 'agent.completed')).toHaveLength(0);
  });

  it('stops before generation on an exhausted budget', async () => {
    const f = await fixture(); await db.db.updateTable('task_agent_budgets').set({ consumed_tokens: 64000 }).where('task_id', '=', f.taskId).execute();
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: done() }]);
    await expect(executor(adapter).execute(f)).rejects.toMatchObject({ code: 'token_exhausted' });
    expect(adapter.calls).toHaveLength(0); expect((await state(f.agentInstanceId)).status).toBe('token_exhausted');
  });

  it('rejects a late provider completion after cancel while still accounting its usage', async () => {
    const f = await fixture(); let release!: (result: AgentResponse) => void;
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: () => new Promise((resolve) => { release = resolve; }) }]);
    const service = executor(adapter); const pending = service.execute(f);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'canceled' });
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(1));
    service.cancel(f.agentInstanceId); await rejected; release(done());
    await vi.waitFor(async () => {
      const calls = await db.db.selectFrom('model_calls').select('status').where('agent_id', '=', f.agentInstanceId).execute();
      expect(calls[0]?.status).toBe('reported');
    });
    expect(await events(f.agentInstanceId, 'agent.completed')).toHaveLength(0);
  });

  it('rejects a mismatched capture before sending any model request', async () => {
    const f = await fixture(); f.context.manifest.approvedPaths = ['documents/unselected.md'];
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: done() }]);
    await expect(executor(adapter).execute(f)).rejects.toMatchObject({ code: 'context_mismatch' });
    expect(adapter.calls).toHaveLength(0);
  });
});
