import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { NullWorkerResultIntegrationService, planningContextSchema,
  type AgentPlan, type PlanningContext, type WorkerExecutionService, type WorkerResultIntegrationService } from '@app/contracts';
import { PgAgentLedger } from '../src/agents/ledger.js';
import { ParallelAssignmentScheduler, PgPlanStore } from '../src/orchestration/index.js';
import { PgWorkerStore } from '../src/workers/store.js';
import { PgTaskService } from '../src/tasks/service.js';
import { WorkerExecutor } from '../src/workers/executor.js';
import { LocalGitService } from '../src/git/service.js';
import { FakeModelAdapter, type ModelAdapter, type AgentResponse } from '../src/models/index.js';
import type { DbHandle } from '../src/db/client.js';
import { BOOT_ID, connectTestDb, insertWorkspace, insertTask, insertRun } from './helpers.js';

let db: DbHandle;
const snapshot = '1'.repeat(40);
const sha = () => createHash('sha1').update(randomUUID()).digest('hex');
const assignment = (id: string, dependsOn: string[] = [], writer = false): AgentPlan['assignments'][number] => ({
  id, dependsOn, preset: writer ? 'writer' : 'analyst', writePaths: writer ? [`documents/${id}.md`] : [], instruction: `Do ${id}`,
});
const plan = (...assignments: AgentPlan['assignments']): AgentPlan => ({ summary: 'Test graph', assignments });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
beforeAll(() => { db = connectTestDb(); });
afterAll(async () => { await db.close(); });

async function fixture(value: AgentPlan, workspaceId?: string, capturedSha = snapshot) {
  workspaceId ??= await insertWorkspace(db.db, 'C05 scheduler');
  const taskId = await insertTask(db.db, workspaceId, { status: 'planning' });
  const runId = await insertRun(db.db, workspaceId, taskId);
  await db.db.updateTable('tasks').set({ active_run_id: runId }).where('id', '=', taskId).execute();
  const context = planningContextSchema.parse({ task: { id: taskId, version: 1, title: 'Task', outcome: 'Outcome', criteria: [], outputPaths: [] },
    guidance: '', discussion: [], sources: [], manifest: { taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0,
      materials: [], approvedPaths: [], approvedCommitSha: capturedSha, draftCheckpointSha: capturedSha, draftFileHashes: {} } });
  await db.db.updateTable('runs').set({ input_snapshot_sha: capturedSha, context_manifest: context.manifest }).where('id', '=', runId).execute();
  const ledger = new PgAgentLedger({ db: db.db, bootId: BOOT_ID });
  const planner = await ledger.createInstance({ runId, agentKey: 'orchestrator', assignmentKey: 'orchestrator', preset: 'orchestrator', modelId: 'fake' });
  await ledger.start(planner.id);
  const digest = createHash('sha256').update(JSON.stringify(context)).digest('hex');
  await new PgPlanStore({ db: db.db, ledger, bootId: BOOT_ID }).save(planner.id, runId, digest, value,
    { inputSnapshotSha: capturedSha, manifest: context.manifest });
  return { workspaceId, taskId, runId, ledger, input: { runId, planningInstanceId: planner.id, context } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const rows = (runId: string) => db.db.selectFrom('agent_instances').selectAll().where('run_id', '=', runId).where('preset', '!=', 'orchestrator').execute();
const events = (runId: string) => db.db.selectFrom('task_events').selectAll().where('run_id', '=', runId).execute();

function runtime(f: Fixture, options: {
  beforeFinish?: (id: string, key: string, context: PlanningContext) => Promise<void>;
  integration?: WorkerResultIntegrationService;
  changed?: boolean;
} = {}) {
  const git = { createResult: vi.fn(async () => ({ branch: 'internal', worktreePath: '/internal' })),
    createWorker: vi.fn(async () => ({ branch: 'internal', worktreePath: '/internal' })) };
  const started: string[] = [];
  const store = new PgWorkerStore(db.db, f.ledger);
  const workers: WorkerExecutionService = {
    execute: vi.fn(async ({ agentInstanceId: id, context }) => {
      const agent = await f.ledger.start(id);
      started.push(agent.assignment_key);
      await options.beforeFinish?.(id, agent.assignment_key, context);
      const resultSha = options.changed && agent.write_paths.length ? sha() : agent.base_sha!;
      // Scripted C04 completion uses the real ledger/write guard and durable
      // completion record. D05 candidates are injected, never simulated Git code.
      if (resultSha !== agent.base_sha) await f.ledger.withActiveWrite(id, async (trx) => {
        await trx.updateTable('agent_instances').set({ result_sha: resultSha }).where('id', '=', id).execute();
      });
      return store.finish(id, { summary: 'Done', references: [], limitations: [], artifacts: [], resultSha }, new AbortController().signal);
    }),
    cancel: vi.fn(),
  };
  const scheduler = new ParallelAssignmentScheduler({ db: db.db, bootId: BOOT_ID, ledger: f.ledger,
    adapter: new FakeModelAdapter([]), workers, git, integration: options.integration });
  return { scheduler, workers, git, started, store };
}

describe('parallel assignment scheduler', () => {
  it('can cancel a live sibling after another assignment exhausts its budget', async () => {
    const f = await fixture(plan(assignment('exhausted'), assignment('peer')));
    const wait = gate();
    const r = runtime(f, { beforeFinish: async (id, key) => {
      if (key === 'peer') { await wait.promise; return; }
      await f.ledger.reserve({ agentInstanceId: id, requestKey: 'too-large', inputTokens: 64000,
        profile: new FakeModelAdapter([]).getModel('analyst') });
    } });
    const running = r.scheduler.schedule(f.input);
    // Observe rejection immediately, before cancellation releases its gates.
    const stopped = expect(running).rejects.toBeDefined();
    try {
      await vi.waitFor(async () => {
        expect((await rows(f.runId)).find((a) => a.assignment_key === 'peer')?.status).toBe('running');
        expect((await db.db.selectFrom('tasks').select('status').where('id', '=', f.taskId).executeTakeFirstOrThrow()).status).toBe('incomplete');
      });
      const tasks = new PgTaskService({ db: db.db, bootId: BOOT_ID, orchestration: {
        onRunCreated() {}, onCancelRequested() { r.scheduler.cancel(f.runId); wait.resolve(); },
      } });
      await tasks.cancel(f.workspaceId, f.taskId);
      await stopped;
      expect((await rows(f.runId)).map((a) => a.status).sort()).toEqual(['canceled', 'token_exhausted']);
      expect(r.workers.cancel).toHaveBeenCalled();
    } finally { wait.resolve(); }
  });

  it('integrates real parallel C04 checkpoints through D05 before a dependent reads both outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c05-d05-'));
    try {
      const workspaceId = await insertWorkspace(db.db, 'C05+D05'); const git = new LocalGitService(root);
      const initial = await git.initialize(workspaceId);
      const f = await fixture(plan(assignment('a', [], true), assignment('b', [], true), assignment('join', ['a', 'b'], true)), workspaceId, initial.mainSha);
      const counts = new Map<string, number>(), started = new Set<string>(), both = gate();
      const tool = (name: string, args: Record<string, unknown>): AgentResponse => ({ toolCalls: [{ name, arguments: args }],
        finishReason: 'STOP', usage: { status: 'reported', totalTokens: 100 } });
      const adapter: ModelAdapter = {
        getModel: () => ({ modelId: 'fake', minOutputTokens: 1, maxOutputTokens: 65536 }),
        countInput: async () => 10,
        generate: async (request) => {
          const first = request.messages[0]; if (first?.role !== 'user') throw new Error('Missing prompt');
          const key = (JSON.parse(first.text!) as { instruction: string }).instruction.slice(3);
          const step = counts.get(key) ?? 0; counts.set(key, step + 1);
          if (key !== 'join' && step === 0) {
            started.add(key); if (started.size === 2) both.resolve(); await both.promise;
            return tool('propose_changes', { changes: [{ path: `documents/${key}.md`, expectedHash: null, newText: key.toUpperCase() }] });
          }
          if (key === 'join' && step === 0) return { ...tool('read_file', { path: 'documents/a.md', source: 'worker' }),
            toolCalls: ['a', 'b'].map((name) => ({ name: 'read_file', arguments: { path: `documents/${name}.md`, source: 'worker' } })) };
          if (key === 'join' && step === 1) {
            const last = request.messages.at(-1); if (last?.role !== 'tool') throw new Error('Missing tool results');
            expect(last.results.map((r) => r.result.text)).toEqual(['A', 'B']);
            return tool('propose_changes', { changes: [{ path: 'documents/join.md', expectedHash: null, newText: 'A+B' }] });
          }
          return tool('finish_assignment', { summary: `Finished ${key}`, references: [], limitations: [], outputPaths: [`documents/${key}.md`] });
        },
      };
      const errors: unknown[] = [];
      const workers = new WorkerExecutor({ db: db.db, ledger: f.ledger, adapter, git,
        materials: { readSelected: async () => { throw new Error('Unexpected material read'); } }, onBackgroundError: (error) => errors.push(error) });
      // No explicit integration injection: production LocalGitService is selected.
      const scheduler = new ParallelAssignmentScheduler({ db: db.db, bootId: BOOT_ID, ledger: f.ledger, adapter, workers, git });
      const result = await scheduler.schedule(f.input);
      expect(Object.values(result.assignments).every((a) => a.status === 'integrated')).toBe(true);
      for (const [name, text] of [['a', 'A'], ['b', 'B'], ['join', 'A+B']]) {
        const path = `documents/${name}.md`;
        expect((await git.readText({ workspaceId, target: { kind: 'result', runId: f.runId }, path, allowedPaths: [path] })).text).toBe(text);
      }
      const agents = await rows(f.runId);
      expect(agents.filter((a) => a.assignment_key !== 'join').map((a) => a.base_sha)).toEqual([initial.mainSha, initial.mainSha]);
      const receipts = (await events(f.runId)).filter((e) => e.payload.phase === 'integration');
      expect(receipts).toHaveLength(3);
      expect(agents.find((a) => a.assignment_key === 'join')!.base_sha).toBe(receipts[1]!.payload.resultSha);
      expect((await git.initialize(workspaceId)).mainSha).toBe(initial.mainSha);
      expect(errors).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120000);

  it('runs the real C04 executor against D02 branches and passes prerequisite evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c05-scheduler-'));
    try {
      const workspaceId = await insertWorkspace(db.db, 'C05 real workers');
      const git = new LocalGitService(root); const initial = await git.initialize(workspaceId);
      const f = await fixture(plan(assignment('analysis'), assignment('write', ['analysis'], true)), workspaceId, initial.mainSha);
      const done = { toolCalls: [{ name: 'finish_assignment', arguments: { summary: 'Verified prerequisite', references: [], limitations: [], outputPaths: [] } }],
        finishReason: 'STOP', usage: { status: 'reported' as const, totalTokens: 100 } };
      const adapter = new FakeModelAdapter([{ inputTokens: 10, result: done }, { inputTokens: 10, result: done }]);
      const errors: unknown[] = [];
      const workers = new WorkerExecutor({ db: db.db, ledger: f.ledger, adapter, git,
        materials: { readSelected: async () => { throw new Error('Unexpected material read'); } }, onBackgroundError: (error) => errors.push(error) });
      const scheduler = new ParallelAssignmentScheduler({ db: db.db, bootId: BOOT_ID, ledger: f.ledger, adapter, workers, git });
      const result = await scheduler.schedule(f.input);
      expect(result.assignments.write!.status).toBe('integrated'); expect(result.resultSha).toBe(initial.mainSha);
      expect(JSON.stringify(adapter.calls[1]!.request.messages)).toContain('Verified prerequisite');
      expect((await git.initialize(workspaceId)).mainSha).toBe(initial.mainSha);
      expect(errors).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('releases a ready dependent while an unrelated worker is still executing', async () => {
    const f = await fixture(plan(assignment('fast'), assignment('slow'), assignment('join', ['fast'])));
    const wait = gate(); const r = runtime(f, { beforeFinish: async (_id, key) => { if (key === 'slow') await wait.promise; } });
    const pending = r.scheduler.schedule(f.input);
    try { await vi.waitFor(() => expect(r.started).toContain('join')); }
    finally { wait.resolve(); }
    expect((await pending).assignments.join!.status).toBe('integrated');
  });

  it('dispatches all ready workers, persists edges first, and starts dependencies only after receipts', async () => {
    const f = await fixture(plan(assignment('a'), assignment('b'), assignment('join', ['a', 'b'])));
    const wait = gate();
    const r = runtime(f, { beforeFinish: async (_id, key) => { if (key !== 'join') await wait.promise; } });
    const pending = r.scheduler.schedule(f.input);
    try {
      await vi.waitFor(() => expect(r.started).toHaveLength(2));
      const waiting = (await rows(f.runId)).find((a) => a.assignment_key === 'join')!;
      expect(waiting.status).toBe('pending'); expect(waiting.started_at).toBeNull(); expect(waiting.deadline_at).toBeNull(); expect(waiting.base_sha).toBeNull();
      expect(await db.db.selectFrom('agent_dependencies').selectAll().where('run_id', '=', f.runId).execute()).toHaveLength(2);
    } finally { wait.resolve(); }
    const result = await pending;
    expect(Object.values(result.assignments).every((a) => a.status === 'integrated')).toBe(true);
    expect(r.started[2]).toBe('join'); expect(r.git.createWorker).not.toHaveBeenCalled();
    expect((await events(f.runId)).filter((e) => e.payload.phase === 'integration')).toHaveLength(3);
  });

  it('has no global two-task cap, even within one workspace', async () => {
    const first = await fixture(plan(assignment('first')));
    const second = await fixture(plan(assignment('second')), first.workspaceId);
    const third = await fixture(plan(assignment('third')), first.workspaceId);
    const wait = gate(); const r = runtime(first, { beforeFinish: () => wait.promise });
    const pending = [first, second, third].map((f) => r.scheduler.schedule(f.input));
    try { await vi.waitFor(() => expect(r.started).toHaveLength(3)); }
    finally { wait.resolve(); }
    expect(await Promise.all(pending)).toHaveLength(3);
  });

  it('coalesces identical calls and rejects another scheduler and durable replay', async () => {
    for (let round = 0; round < 3; round++) {
      const f = await fixture(plan(assignment('a'))); const wait = gate();
      const r = runtime(f, { beforeFinish: () => wait.promise });
      const first = r.scheduler.schedule(f.input);
      expect(r.scheduler.schedule(f.input)).toBe(first);
      try {
        await vi.waitFor(() => expect(r.started).toEqual(['a']));
        await expect(runtime(f).scheduler.schedule(f.input)).rejects.toMatchObject({ code: 'already_scheduled' });
      } finally { wait.resolve(); }
      await first;
      await expect(r.scheduler.schedule(f.input)).rejects.toMatchObject({ code: 'already_scheduled' });
      expect(await rows(f.runId)).toHaveLength(1);
    }
  });

  it('serializes integrations and selects dependent bases from the integrated head', async () => {
    const f = await fixture(plan(assignment('a', [], true), assignment('b', [], true), assignment('join', ['a', 'b'], true)));
    const release = gate(); const heads: string[] = []; const inputs: Array<Parameters<WorkerResultIntegrationService['integrate']>[0]> = [];
    const integration: WorkerResultIntegrationService = { integrate: vi.fn(async (input, guard) => {
      inputs.push(input);
      if (inputs.length === 1) await release.promise;
      const next = sha(); heads.push(next);
      await guard({ status: 'integrated', resultSha: next }, async () => {}); return 'handled';
    }) };
    const r = runtime(f, { changed: true, integration }); const pending = r.scheduler.schedule(f.input);
    try {
      await vi.waitFor(async () => {
        expect(inputs).toHaveLength(1);
        expect((await rows(f.runId)).filter((a) => a.status === 'completed')).toHaveLength(2);
      });
      expect(r.started).not.toContain('join');
    } finally { release.resolve(); }
    const result = await pending;
    expect(inputs.map((i) => i.expectedResultSha)).toEqual([snapshot, heads[0], heads[1]]);
    expect(inputs[2]!.baseSha).toBe(heads[1]); expect(result.resultSha).toBe(heads[2]);
    expect(r.git.createWorker).toHaveBeenCalledTimes(3);
    expect((await rows(f.runId)).find((a) => a.assignment_key === 'join')!.base_sha).toBe(heads[1]);
  });

  it('surfaces D05 absence and does not release dependents of completed changes', async () => {
    const f = await fixture(plan(assignment('a', [], true), assignment('join', ['a'])));
    const integration = new NullWorkerResultIntegrationService();
    const r = runtime(f, { changed: true, integration }); const result = await r.scheduler.schedule(f.input);
    expect(result.assignments).toEqual({ a: { status: 'pending_integration' }, join: { status: 'blocked' } });
    expect(result.resultSha).toBe(snapshot); expect(integration.calls).toHaveLength(1);
    const waiting = (await rows(f.runId)).find((a) => a.assignment_key === 'join')!;
    expect(waiting.deadline_at).toBeNull();
    expect((await events(f.runId)).some((e) => e.payload.reason === 'pending_integration')).toBe(true);
  });

  it('retains conflicts, blocks downstream work, and lets an independent worker finish', async () => {
    const f = await fixture(plan(assignment('a', [], true), assignment('peer'), assignment('join', ['a'])));
    const publish = vi.fn(async () => {});
    const r = runtime(f, { changed: true, integration: { integrate: async (_input, guard) => {
      await guard({ status: 'conflict', paths: ['documents/a.md'] }, publish); return 'handled';
    } } });
    const result = await r.scheduler.schedule(f.input);
    expect(result.assignments.a).toEqual({ status: 'conflict', paths: ['documents/a.md'] });
    expect(result.assignments.peer!.status).toBe('integrated'); expect(result.assignments.join!.status).toBe('blocked');
    expect(publish).not.toHaveBeenCalled(); expect(result.resultSha).toBe(snapshot);
    expect((await db.db.selectFrom('tasks').select('status').where('id', '=', f.taskId).executeTakeFirstOrThrow()).status).toBe('conflict');
  });

  it('preserves worker failure and finishes independent peers without retrying', async () => {
    const f = await fixture(plan(assignment('fail'), assignment('peer'), assignment('join', ['fail'])));
    const r = runtime(f, { beforeFinish: async (id, key) => {
      if (key === 'fail') { await new PgWorkerStore(db.db, f.ledger).fail(id, 'test_failure'); throw new Error('secret provider/path'); }
    } });
    const result = await r.scheduler.schedule(f.input);
    expect(result.assignments).toMatchObject({ fail: { status: 'failed' }, peer: { status: 'integrated' }, join: { status: 'blocked' } });
    expect(r.workers.execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await events(f.runId))).not.toContain('secret provider/path');
  });

  it.each(['local_cancel', 'canceled_run', 'old_boot', 'superseded', 'head_changed'] as const)(
    'rejects publication that becomes stale while queued: %s', async (condition) => {
      const f = await fixture(plan(assignment('a', [], true), assignment('join', ['a'])));
      const publish = vi.fn(async () => {});
      let r: ReturnType<typeof runtime>;
      r = runtime(f, { changed: true, integration: { integrate: async (_input, guard) => {
        if (condition === 'local_cancel') r.scheduler.cancel(f.runId);
        if (condition === 'canceled_run') await db.db.updateTable('runs').set({ status: 'canceled' }).where('id', '=', f.runId).execute();
        if (condition === 'old_boot') await db.db.updateTable('runs').set({ boot_id: randomUUID() }).where('id', '=', f.runId).execute();
        if (condition === 'superseded') await db.db.updateTable('tasks').set({ active_run_id: null }).where('id', '=', f.taskId).execute();
        if (condition === 'head_changed') await db.db.updateTable('runs').set({ result_head_sha: sha() }).where('id', '=', f.runId).execute();
        await guard({ status: 'integrated', resultSha: sha() }, publish); return 'handled';
      } } });
      const result = await r.scheduler.schedule(f.input).catch(() => null);
      expect(publish).not.toHaveBeenCalled(); expect(r.started).toEqual(['a']);
      expect((await events(f.runId)).filter((e) => e.payload.phase === 'integration')).toHaveLength(0);
      if (condition === 'head_changed') expect(result?.assignments.a!.status).toBe('failed');
      else expect(result).toBeNull();
    });

  it('does not trust an integration response without its guarded receipt', async () => {
    const f = await fixture(plan(assignment('a', [], true), assignment('join', ['a'])));
    const r = runtime(f, { changed: true, integration: { integrate: async () => 'handled' } });
    const result = await r.scheduler.schedule(f.input);
    expect(result.assignments.a!.status).toBe('failed'); expect(result.assignments.join!.status).toBe('blocked');
    expect(result.resultSha).toBe(snapshot);
  });

  it('rechecks local cancellation after waiting for the task row lock', async () => {
    const f = await fixture(plan(assignment('a', [], true)));
    const publish = vi.fn(async () => {});
    let r: ReturnType<typeof runtime>;
    r = runtime(f, { changed: true, integration: { integrate: async (_input, guard) => {
      const held = gate(), release = gate();
      const blocker = db.db.transaction().execute(async (trx) => {
        await trx.selectFrom('tasks').select('id').where('id', '=', f.taskId).forUpdate().execute();
        held.resolve(); await release.promise;
      });
      await held.promise;
      const result = guard({ status: 'integrated', resultSha: sha() }, publish);
      // Observe actual lock contention, not a timing guess about a queued guard.
      try {
        await vi.waitFor(async () => {
          const waiting = await sql<{ blocked: boolean }>`select exists (
            select 1 from pg_stat_activity where wait_event_type = 'Lock'
              and query like '%from "tasks"%' and query like '%for update%'
          ) as blocked`.execute(db.db);
          expect(waiting.rows[0]!.blocked).toBe(true);
        });
        r.scheduler.cancel(f.runId);
      } finally { release.resolve(); await blocker; }
      await result; return 'handled';
    } } });
    await expect(r.scheduler.schedule(f.input)).rejects.toMatchObject({ code: 'inactive' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects changed context and corrupted saved plans before creating workers', async () => {
    const f = await fixture(plan(assignment('a'))); const r = runtime(f);
    const changed = structuredClone(f.input); changed.context.guidance = 'Altered';
    await expect(r.scheduler.schedule(changed)).rejects.toMatchObject({ code: 'context_mismatch' });
    const event = (await events(f.runId)).find((e) => e.payload.plan)!;
    await db.db.updateTable('task_events').set({ payload: { ...event.payload, plan: plan(assignment('a', ['a'])) } }).where('id', '=', event.id).execute();
    await expect(r.scheduler.schedule(f.input)).rejects.toMatchObject({ code: 'stored_plan_invalid' });
    expect(await rows(f.runId)).toHaveLength(0); expect(r.git.createResult).not.toHaveBeenCalled();
  });

  it('records preparation failures without starting a clock or stranding peers', async () => {
    const f = await fixture(plan(assignment('a', [], true), assignment('peer'), assignment('join', ['a'])));
    const r = runtime(f); r.git.createWorker.mockRejectedValueOnce(new Error('private filesystem path'));
    const result = await r.scheduler.schedule(f.input);
    expect(result.assignments).toMatchObject({ a: { status: 'failed' }, peer: { status: 'integrated' }, join: { status: 'blocked' } });
    const failed = (await rows(f.runId)).find((a) => a.assignment_key === 'a')!;
    expect(failed.status).toBe('failed'); expect(failed.started_at).toBeNull();
  });
});
