import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentHistoryDetailSchema, listAgentHistoryResponseSchema, type PlanningContext } from '@app/contracts';
import { PgAgentLedger } from '../src/agents/index.js';
import { WorkerExecutor } from '../src/workers/index.js';
import { FakeModelAdapter, type AgentResponse, type ToolCall } from '../src/models/index.js';
import { LocalGitService } from '../src/git/service.js';
import { blobHash } from '../src/git/files.js';
import { AgentHistoryService } from '../src/agent-history/service.js';
import { registerAgentHistoryRoutes } from '../src/agent-history/routes.js';
import { registerErrorHandler } from '../src/http/errors.js';
import type { DbHandle } from '../src/db/client.js';
import { BOOT_ID, connectTestDb, insertRun, insertTask, insertWorkspace } from './helpers.js';

let db: DbHandle, root: string, git: LocalGitService, ledger: PgAgentLedger, history: AgentHistoryService;
let workspaceId: string, base: string;
const errors: unknown[] = [];
const path = 'documents/guide.md';
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: randomUUID(), name, arguments: args });
const turn = (thoughts: string, ...toolCalls: ToolCall[]): { inputTokens: number; result: AgentResponse } => ({
  inputTokens: 10,
  result: { thoughts, toolCalls, finishReason: 'STOP', usage: { status: 'reported', totalTokens: 100 },
    providerState: { parts: [{ thoughtSignature: 'kept' }] } },
});

beforeAll(async () => {
  db = connectTestDb(); root = await mkdtemp(join(tmpdir(), 'agent-history-')); git = new LocalGitService(join(root, 'git'));
  ledger = new PgAgentLedger({ db: db.db, bootId: BOOT_ID });
  history = new AgentHistoryService({ db: db.db, git });
  workspaceId = await insertWorkspace(db.db, 'Agent history');
  const seed = await insertTask(db.db, workspaceId);
  base = (await git.checkpoint({ workspaceId, taskId: seed, files: [{ path, text: 'Original source' }] })).commitSha;
});
afterEach(() => { expect(errors.splice(0)).toEqual([]); });
afterAll(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });

async function writer() {
  const taskId = await insertTask(db.db, workspaceId, { status: 'working', title: 'Write the guide' });
  const runId = await insertRun(db.db, workspaceId, taskId, { status: 'working' });
  await db.db.updateTable('tasks').set({ active_run_id: runId }).where('id', '=', taskId).execute();
  const context: PlanningContext = { task: { id: taskId, version: 1, title: 'Write the guide', outcome: 'Explain', criteria: [], outputPaths: [path] },
    guidance: '', discussion: [], sources: [], manifest: {
      taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [], approvedPaths: [path],
      approvedCommitSha: base, draftCheckpointSha: base, draftFileHashes: { [path]: blobHash(Buffer.from('Original source')) },
    } };
  await db.db.updateTable('runs').set({ input_snapshot_sha: base, context_manifest: context.manifest }).where('id', '=', runId).execute();
  const agent = await ledger.createInstance({ runId, agentKey: 'writer', assignmentKey: 'write-guide', preset: 'writer',
    modelId: 'fake', instruction: 'Rewrite the guide clearly.', writePaths: [path] });
  await db.db.updateTable('agent_instances').set({ base_sha: base }).where('id', '=', agent.id).execute();
  await git.createWorker({ workspaceId, agentInstanceId: agent.id, baseSha: base });
  return { taskId, runId, agentInstanceId: agent.id, context };
}

describe('agent history', { timeout: 120_000 }, () => {
  it('records the thought process, tool outcomes and own diff of a finished worker', async () => {
    const f = await writer();
    const adapter = new FakeModelAdapter([
      turn('I should read the current guide first.', call('read_file', { path, source: 'worker' })),
      // A stale hash is a repairable error the model sees and corrects.
      turn('Replace the text.', call('propose_changes', { changes: [{ path, expectedHash: 'f'.repeat(40), newText: 'Stale' }] })),
      turn('The hash was wrong; use the one I read.', call('propose_changes', { changes: [{ path,
        expectedHash: blobHash(Buffer.from('Original source')), newText: 'A clearer guide.\n' }] })),
      turn('Done.', call('finish_assignment', { summary: 'Rewrote the guide.', references: [],
        limitations: ['Not checked by a person.'], outputPaths: [path] })),
    ]);
    const executor = new WorkerExecutor({ db: db.db, ledger, adapter, git, materials: { readSelected: async () => { throw new Error('unused'); } },
      onBackgroundError: (error) => errors.push(error) });

    // Not listed while it is still working.
    await ledger.start(f.agentInstanceId);
    expect((await history.list(workspaceId)).map((a) => a.agentInstanceId)).not.toContain(f.agentInstanceId);
    await executor.execute({ agentInstanceId: f.agentInstanceId, context: f.context });

    const listed = (await history.list(workspaceId)).find((a) => a.agentInstanceId === f.agentInstanceId);
    expect(listed).toMatchObject({ taskTitle: 'Write the guide', assignmentKey: 'write-guide', status: 'completed',
      summary: 'Rewrote the guide.', stepCount: 7, attempt: 1 });

    const detail = agentHistoryDetailSchema.parse(await history.read(workspaceId, f.agentInstanceId));
    expect(detail.limitations).toEqual(['Not checked by a person.']);
    expect(detail.steps.map((step) => step.kind)).toEqual(
      ['model_turn', 'tool_results', 'model_turn', 'tool_results', 'model_turn', 'tool_results', 'model_turn']);
    const [first, read, , stale] = detail.steps;
    expect(first).toMatchObject({ thoughts: 'I should read the current guide first.', toolCalls: [{ name: 'read_file' }] });
    expect(read).toMatchObject({ results: [{ name: 'read_file', outcome: 'ok', errorCode: null }] });
    expect(stale).toMatchObject({ results: [{ name: 'propose_changes', outcome: 'error', errorCode: 'FILE_VERSION_CHANGED' }] });
    // Opaque provider state never reaches a trace.
    expect(JSON.stringify(detail.steps)).not.toContain('thoughtSignature');

    expect(detail.changes.available).toBe(true);
    expect(detail.changes.changedFiles).toHaveLength(1);
    expect(detail.changes.changedFiles[0]).toMatchObject({ path, changeKind: 'modified' });
    expect(detail.changes.changedFiles[0]!.diff).toContain('+A clearer guide.');
  });

  it('clips long tool arguments so a trace is not a copy of the file', async () => {
    const f = await writer();
    await ledger.start(f.agentInstanceId);
    const long = 'x'.repeat(5000);
    const adapter = new FakeModelAdapter([
      turn('Write it all.', call('propose_changes', { changes: [{ path, expectedHash: blobHash(Buffer.from('Original source')), newText: long }] })),
      turn('Finish.', call('finish_assignment', { summary: 'Wrote.', references: [], limitations: [], outputPaths: [path] })),
    ]);
    await new WorkerExecutor({ db: db.db, ledger, adapter, git, materials: { readSelected: async () => { throw new Error('unused'); } },
      onBackgroundError: (error) => errors.push(error) }).execute({ agentInstanceId: f.agentInstanceId, context: f.context });
    const [turnStep] = (await history.read(workspaceId, f.agentInstanceId)).steps;
    expect(JSON.stringify(turnStep).length).toBeLessThan(2000);
    expect(JSON.stringify(turnStep)).toContain('(5000 characters)');
  });

  it('reports failures, hides other workspaces, and serves both routes', async () => {
    const f = await writer();
    await db.db.updateTable('agent_instances').set({ status: 'failed', ended_at: new Date() }).where('id', '=', f.agentInstanceId).execute();
    await db.db.insertInto('task_events').values({ workspace_id: workspaceId, task_id: f.taskId, run_id: f.runId,
      event_key: `agent:${f.agentInstanceId}:failed`, type: 'agent.failed', payload: { agentId: f.agentInstanceId, code: 'blocked_response' } }).execute();

    const detail = await history.read(workspaceId, f.agentInstanceId);
    expect(detail).toMatchObject({ failureCode: 'blocked_response', steps: [], changes: { available: true, changedFiles: [] } });

    const other = await insertWorkspace(db.db, 'Elsewhere');
    await expect(history.read(other, f.agentInstanceId)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    expect(await history.list(other)).toEqual([]);
    await expect(history.list(randomUUID())).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    const app = Fastify();
    registerErrorHandler(app);
    await registerAgentHistoryRoutes(app, history);
    try {
      const list = await app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/agent-history` });
      expect(list.statusCode).toBe(200);
      const agents = listAgentHistoryResponseSchema.parse(list.json()).agents;
      expect(agents.find((a) => a.agentInstanceId === f.agentInstanceId)).toMatchObject({ status: 'failed' });
      // Model IDs and full instructions stay server-side.
      expect(list.body).not.toContain('"fake"');
      expect(list.body).not.toContain('modelId');
      const one = await app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/agent-history/${f.agentInstanceId}` });
      expect(one.statusCode).toBe(200);
      const missing = await app.inject({ method: 'GET', url: `/api/workspaces/${other}/agent-history/${f.agentInstanceId}` });
      expect(missing.statusCode).toBe(404);
      const invalid = await app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/agent-history/not-a-uuid` });
      expect(invalid.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
