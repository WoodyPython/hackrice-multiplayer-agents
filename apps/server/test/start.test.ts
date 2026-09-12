import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contextManifestSchema, type AgentPlan, type PlanningContext,
  type PostTaskRequest, type TaskDetail, type WorkerExecutionService,
} from '@app/contracts';
import { PgAgentLedger } from '../src/agents/ledger.js';
import { PgCheckpointStore } from '../src/collaboration/checkpoint-store.js';
import { LiveDocumentCoordinator } from '../src/collaboration/coordinator.js';
import type { DbHandle } from '../src/db/client.js';
import { PgDiscussionService } from '../src/discussion/service.js';
import { PgDraftStore } from '../src/drafts/store.js';
import { runGit } from '../src/git/command.js';
import { LocalGitService } from '../src/git/service.js';
import { LocalDiskBlobStore } from '../src/materials/blob-store.js';
import { PgMaterialService } from '../src/materials/service.js';
import type { AgentResponse, ModelAdapter } from '../src/models/index.js';
import { OrchestratorPlanner, ParallelAssignmentScheduler, StartOrchestrator } from '../src/orchestration/index.js';
import { PgTaskService } from '../src/tasks/service.js';
import { PgWorkerStore } from '../src/workers/store.js';
import { BOOT_ID, connectTestDb, insertWorkspace } from './helpers.js';

/**
 * C06 runs against real Postgres and a real repository, because everything it
 * owns is a boundary between the two: the manifest is what the database records
 * and the snapshot is what Git resolves. Only the provider is scripted.
 */

let db: DbHandle;
let root: string;
let git: LocalGitService;
let drafts: PgDraftStore;
let collaboration: LiveDocumentCoordinator;
let materials: PgMaterialService;
let ledger: PgAgentLedger;
let discussion: PgDiscussionService;
let tasks: PgTaskService;
let orchestrator: StartOrchestrator;
let workers: WorkerExecutionService;
let scheduler: ParallelAssignmentScheduler;

const errors: unknown[] = [];
/** Every context the orchestrator model was asked to plan from. */
const planned: PlanningContext[] = [];
let plan: AgentPlan;
/** Scripts a provider refusal, which is fatal rather than repairable. */
let blockReason: string | undefined;

const analyst = (id: string, dependsOn: string[] = []): AgentPlan['assignments'][number] =>
  ({ id, preset: 'analyst', dependsOn, writePaths: [], instruction: `Analyse for ${id}` });

beforeEach(async () => {
  db = connectTestDb();
  root = await mkdtemp(join(tmpdir(), 'c06-start-'));
  errors.length = 0;
  planned.length = 0;
  blockReason = undefined;
  plan = { summary: 'One analysis', assignments: [analyst('facts')] };

  git = new LocalGitService(root);
  drafts = new PgDraftStore({ db: db.db });
  collaboration = new LiveDocumentCoordinator({ drafts, git, debounceMs: 60_000 },
    { drafts, git, checkpoints: new PgCheckpointStore(db.db) });
  materials = new PgMaterialService({ db: db.db, blobs: new LocalDiskBlobStore(join(root, 'materials')) });
  ledger = new PgAgentLedger({ db: db.db, bootId: BOOT_ID });
  discussion = new PgDiscussionService({ db: db.db });

  const adapter: ModelAdapter = {
    getModel: () => ({ modelId: 'fake-orchestrator', minOutputTokens: 1, maxOutputTokens: 65_536 }),
    countInput: async () => 10,
    generate: async (request): Promise<AgentResponse> => {
      const first = request.messages[0];
      if (first?.role !== 'user') throw new Error('Missing captured context');
      planned.push((JSON.parse(first.text) as { capturedContext: PlanningContext }).capturedContext);
      const usage = { status: 'reported' as const, totalTokens: 100 };
      if (blockReason) return { toolCalls: [], blockReason, usage };
      return { text: JSON.stringify(plan), toolCalls: [], finishReason: 'STOP', usage };
    },
  };

  // Scripted C04: a read-only worker that completes against its assigned base.
  const store = new PgWorkerStore(db.db, ledger);
  workers = {
    execute: vi.fn(async ({ agentInstanceId }) => {
      const agent = await ledger.start(agentInstanceId);
      return store.finish(agentInstanceId, { summary: `Did ${agent.assignment_key}`, references: [],
        limitations: [], artifacts: [], resultSha: agent.base_sha! }, new AbortController().signal);
    }),
    cancel: vi.fn(),
  };
  scheduler = new ParallelAssignmentScheduler({ db: db.db, bootId: BOOT_ID, ledger, adapter, workers, git });
  orchestrator = new StartOrchestrator({
    db: db.db, bootId: BOOT_ID, ledger, adapter, git, materials, drafts, collaboration, scheduler,
    planner: new OrchestratorPlanner({ db: db.db, ledger, adapter, bootId: BOOT_ID,
      onBackgroundError: (error) => errors.push(error) }),
    onBackgroundError: (error) => errors.push(error),
  });
  tasks = new PgTaskService({ db: db.db, bootId: BOOT_ID, orchestration: orchestrator });
});

afterEach(async () => {
  await orchestrator.close();
  await collaboration.close();
  await db.close();
  await rm(root, { recursive: true, force: true });
});

// --- fixtures ---------------------------------------------------------------

const run = (runId: string) =>
  db.db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
const task = (taskId: string) =>
  db.db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow();
const instances = (runId: string) =>
  db.db.selectFrom('agent_instances').selectAll().where('run_id', '=', runId).orderBy('created_at').execute();
const events = (runId: string) =>
  db.db.selectFrom('task_events').selectAll().where('run_id', '=', runId).orderBy('id').execute();

async function settled(runId: string) {
  await vi.waitFor(async () => expect((await run(runId)).ended_at).not.toBeNull(),
    { timeout: 20_000, interval: 20 });
  return run(runId);
}

async function reason(runId: string): Promise<unknown> {
  const start = (await events(runId)).filter((event) => event.event_key.startsWith(`run:${runId}:start:`));
  return start.at(-1)?.payload;
}

async function post(workspaceId: string, input: Partial<PostTaskRequest> = {}): Promise<TaskDetail> {
  return tasks.post(workspaceId, {
    kind: 'agent_task', title: 'Launch FAQ', outcome: 'Produce an FAQ from the brief',
    criteria: ['Accurate'], outputPaths: ['documents/faq.md'], inputs: [],
    creatorGuestLabel: 'Guest Cedar', ...input,
  } as PostTaskRequest);
}

async function start(workspaceId: string, detail: TaskDetail): Promise<string> {
  const started = await tasks.start(workspaceId, detail.id, {
    expectedVersion: (await task(detail.id)).version, clientRequestId: randomUUID(),
  });
  return started.run.id;
}

/**
 * Publishes a commit on approved main, which no service method does yet: Apply
 * is D07. Used to put a run's two inputs genuinely out of step.
 */
async function commitOnMain(workspaceId: string, files: Array<{ path: string; text: string }>): Promise<string> {
  return git.withRepository(workspaceId, async (repo) => {
    const indexFile = join(root, `index-${randomUUID()}`);
    const entries: string[] = [];
    for (const file of files) {
      const hash = (await runGit(['--git-dir', repo.repositoryPath, 'hash-object', '-w', '--stdin'],
        { input: file.text })).stdout.trim();
      entries.push(`100644 ${hash}\t${file.path}`);
    }
    await runGit(['--git-dir', repo.repositoryPath, 'read-tree', repo.mainSha], { indexFile });
    await runGit(['--git-dir', repo.repositoryPath, 'update-index', '--add', '--index-info'],
      { indexFile, input: `${entries.join('\n')}\n` });
    const tree = (await runGit(['--git-dir', repo.repositoryPath, 'write-tree'], { indexFile })).stdout.trim();
    const commit = (await runGit(['--git-dir', repo.repositoryPath, 'commit-tree', tree,
      '-p', repo.mainSha, '-m', 'Approve'])).stdout.trim();
    await runGit(['--git-dir', repo.repositoryPath, 'update-ref', 'refs/heads/main', commit, repo.mainSha]);
    await rm(indexFile, { force: true });
    return commit;
  });
}

// ---------------------------------------------------------------------------

describe('C06 explicit start', () => {
  it('captures selected inputs, plans, dispatches, and settles the run for review', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 start');
    const approvedSha = await commitOnMain(workspaceId, [{ path: 'documents/policy.md', text: 'Approved policy' }]);

    const detail = await post(workspaceId);
    // Section 3.3's two sources: one attached to the task, one explicitly
    // selected. Reading only the selection would silently drop the attachment.
    const attached = await materials.upload(workspaceId, { filename: 'brief.md',
      bytes: Buffer.from('Attached brief'), guestLabel: 'Guest Cedar', taskId: detail.id });
    const selected = await materials.upload(workspaceId, { filename: 'notes.md',
      bytes: Buffer.from('Selected notes'), guestLabel: 'Guest Fir' });
    await tasks.revise(workspaceId, detail.id, { expectedVersion: detail.version,
      inputs: [{ materialId: selected.material.id }, { approvedPath: 'documents/policy.md' }] });

    const draft = await drafts.openForTask(workspaceId, detail.id, 'documents/faq.md');
    await git.checkpoint({ workspaceId, taskId: detail.id, files: [{ path: 'documents/faq.md', text: 'Draft FAQ' }] });
    await discussion.post(workspaceId, detail.id, { body: 'Include pricing', guestLabel: 'Guest Cedar', materialIds: [] });

    const runId = await start(workspaceId, detail);
    // Section 2.3: this lands after the cutoff and must reach no agent.
    await discussion.post(workspaceId, detail.id, { body: 'Also mention support', guestLabel: 'Guest Fir', materialIds: [] });

    const settledRun = await settled(runId);
    expect(errors).toEqual([]);
    expect(settledRun.status).toBe('completed');
    expect((await task(detail.id)).status).toBe('ready_for_review');
    expect((await task(detail.id)).active_run_id).toBeNull();

    const manifest = contextManifestSchema.parse(settledRun.context_manifest);
    expect(manifest.materials.map((m) => m.materialId).sort())
      .toEqual([attached.material.id, selected.material.id].sort());
    expect(manifest.approvedPaths).toEqual(['documents/policy.md']);
    expect(manifest.approvedCommitSha).toBe(approvedSha);
    expect(Object.keys(manifest.draftFileHashes)).toEqual(['documents/faq.md']);
    expect(manifest.draftCheckpointSha).toBe(settledRun.input_snapshot_sha);
    expect(manifest.discussionCutoffSeq).toBe(1);

    // The captured context the orchestrator model actually received.
    const context = planned[0]!;
    expect(planned).toHaveLength(1);
    expect(context.task).toMatchObject({ id: detail.id, version: settledRun.task_version, title: 'Launch FAQ' });
    expect(context.discussion).toEqual([{ seq: 1, body: 'Include pricing' }]);
    expect(context.sources.map((source) => source.kind === 'material' ? source.text : `${source.kind}:${source.text}`).sort())
      .toEqual(['Attached brief', 'Selected notes', 'approved:Approved policy', 'draft:Draft FAQ'].sort());
    expect(draft.path).toBe('documents/faq.md');

    const created = await instances(runId);
    expect(created.map((row) => [row.preset, row.agent_key, row.status]))
      .toEqual([['orchestrator', 'orchestrator', 'completed'], ['analyst', 'facts', 'completed']]);
    const capture = (await events(runId)).find((event) => event.event_key === `run:${runId}:start:context_captured`);
    expect(capture?.payload).toMatchObject({ phase: 'start', reason: 'context_captured',
      inputSnapshotSha: settledRun.input_snapshot_sha, materials: 2, sources: 4 });
    expect(capture?.payload.omitted).toBeUndefined();
  });

  it('combines a diverged main and draft into one snapshot the run works from', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 combine');
    const detail = await post(workspaceId);
    await drafts.openForTask(workspaceId, detail.id, 'documents/faq.md');
    const checkpoint = await git.checkpoint({ workspaceId, taskId: detail.id,
      files: [{ path: 'documents/faq.md', text: 'Draft FAQ' }] });
    // Main moves independently, touching a different file: combinable, not a
    // conflict. Section 8.4's S must contain both.
    const approved = await commitOnMain(workspaceId, [{ path: 'documents/policy.md', text: 'Approved policy' }]);

    const runId = await start(workspaceId, detail);
    const settledRun = await settled(runId);
    expect(errors).toEqual([]);
    expect(settledRun.status).toBe('completed');
    const snapshot = settledRun.input_snapshot_sha!;
    expect(snapshot).not.toBe(approved);
    expect(snapshot).not.toBe(checkpoint.commitSha);

    for (const [path, text] of [['documents/faq.md', 'Draft FAQ'], ['documents/policy.md', 'Approved policy']]) {
      expect((await git.readText({ workspaceId, target: { kind: 'commit', commitSha: snapshot },
        path: path!, allowedPaths: [path!] })).text).toBe(text);
      // The run's result branch starts at S, so a worker reads both.
      expect((await git.readText({ workspaceId, target: { kind: 'result', runId },
        path: path!, allowedPaths: [path!] })).text).toBe(text);
    }
    // Neither input was rewritten; the contributor keeps their own lineage.
    expect((await git.initialize(workspaceId)).mainSha).toBe(approved);
    expect((await git.readText({ workspaceId, target: { kind: 'draft', taskId: detail.id },
      path: 'documents/policy.md', allowedPaths: ['documents/policy.md'] })).text).toBeNull();
  });

  it('ends the run in a terminal state when the start snapshot conflicts, before any model call', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 conflict');
    const detail = await post(workspaceId);
    await drafts.openForTask(workspaceId, detail.id, 'documents/faq.md');
    // The human draft branches from the main of its creation...
    await git.checkpoint({ workspaceId, taskId: detail.id, files: [{ path: 'documents/faq.md', text: 'Draft answer' }] });
    // ...and main then moves independently, changing the same file (section 8.4).
    await commitOnMain(workspaceId, [{ path: 'documents/faq.md', text: 'Approved answer' }]);

    const runId = await start(workspaceId, detail);
    const settledRun = await settled(runId);
    expect(errors).toEqual([]);
    expect(settledRun.status).toBe('incomplete');
    expect(settledRun.input_snapshot_sha).toBeNull();
    expect((await task(detail.id)).status).toBe('conflict');
    expect((await task(detail.id)).active_run_id).toBeNull();
    expect(await reason(runId)).toMatchObject({ reason: 'snapshot_conflict', paths: ['documents/faq.md'] });
    // No model call, no planning instance: the conflict is surfaced first.
    expect(planned).toEqual([]);
    expect(await instances(runId)).toEqual([]);
  });

  it('reports a task revised between the Start transaction and capture', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 race');
    const detail = await post(workspaceId);
    const runId = await start(workspaceId, detail);
    await settled(runId);

    // The same run, replayed against a task that has since moved on.
    const next = await tasks.revise(workspaceId, detail.id, { expectedVersion: detail.version, outcome: 'Changed' });
    await db.db.updateTable('runs').set({ status: 'planning', ended_at: null }).where('id', '=', runId).execute();
    await db.db.updateTable('tasks').set({ status: 'planning', active_run_id: runId }).where('id', '=', detail.id).execute();
    planned.length = 0;
    orchestrator.onRunCreated({ workspaceId, taskId: detail.id, runId });

    const settledRun = await settled(runId);
    expect(settledRun.status).toBe('incomplete');
    expect((await task(detail.id)).status).toBe('incomplete');
    expect(await reason(runId)).toMatchObject({ reason: 'task_version_changed' });
    expect(next.version).toBe(detail.version + 1);
    expect(planned).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports a fatal planning failure as an incomplete run rather than leaving it planning', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 blocked plan');
    blockReason = 'SAFETY';
    const detail = await post(workspaceId);
    const runId = await start(workspaceId, detail);

    const settledRun = await settled(runId);
    // Capture still succeeded, so the saved inputs stay inspectable.
    expect(settledRun.status).toBe('incomplete');
    expect(settledRun.input_snapshot_sha).not.toBeNull();
    expect((await task(detail.id)).status).toBe('incomplete');
    expect((await task(detail.id)).active_run_id).toBeNull();
    expect((await instances(runId)).map((row) => [row.preset, row.status])).toEqual([['orchestrator', 'failed']]);
    expect(await reason(runId)).toMatchObject({ reason: 'planning_blocked_response' });
    // Section 13.3: a stable code, never provider text.
    expect(JSON.stringify(await events(runId))).not.toContain('SAFETY');
  });

  it('ignores a run from a previous boot and never writes to it', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 previous boot');
    const detail = await post(workspaceId);
    const runId = await start(workspaceId, detail);
    await settled(runId);

    const previous = randomUUID();
    await db.db.updateTable('runs')
      .set({ status: 'planning', ended_at: null, boot_id: previous, input_snapshot_sha: null, context_manifest: null })
      .where('id', '=', runId).execute();
    await db.db.updateTable('tasks').set({ status: 'planning', active_run_id: runId }).where('id', '=', detail.id).execute();
    const before = (await events(runId)).length;

    orchestrator.onRunCreated({ workspaceId, taskId: detail.id, runId });
    await orchestrator.close();

    expect((await run(runId)).status).toBe('planning');
    expect((await run(runId)).input_snapshot_sha).toBeNull();
    expect((await events(runId)).length).toBe(before);
    expect(errors).toEqual([]);
  });

  it('never throws into the Start caller, and does not re-trigger on redelivery', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 hook');
    const detail = await post(workspaceId);
    const unknown = { workspaceId, taskId: detail.id, runId: randomUUID() };
    expect(() => orchestrator.onRunCreated(unknown)).not.toThrow();

    const runId = await start(workspaceId, detail);
    orchestrator.onRunCreated({ workspaceId, taskId: detail.id, runId });
    orchestrator.onRunCreated({ workspaceId, taskId: detail.id, runId });
    await settled(runId);

    // One capture, one planning instance, one dispatch, whatever the delivery.
    expect(planned).toHaveLength(1);
    expect((await instances(runId))).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('stops local execution when a contributor cancels the run', async () => {
    const workspaceId = await insertWorkspace(db.db, 'C06 cancel');
    const detail = await post(workspaceId);
    const runId = await start(workspaceId, detail);
    await settled(runId);

    const stop = vi.spyOn(scheduler, 'cancel');
    await db.db.updateTable('runs').set({ status: 'working', ended_at: null }).where('id', '=', runId).execute();
    await db.db.updateTable('tasks').set({ status: 'working', active_run_id: runId }).where('id', '=', detail.id).execute();
    await tasks.cancel(workspaceId, detail.id);

    // B03 owns the durable cancellation; C06 owns the local scopes.
    expect(stop).toHaveBeenCalledWith(runId);
    expect((await run(runId)).status).toBe('canceled');
    expect((await task(detail.id)).status).toBe('canceled');
  });
});
