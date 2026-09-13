import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { LIVE_ACK_ACCEPTED, LIVE_MESSAGE_ACK, LIVE_TEXT_NAME, liveRoomPath, reviewDetailSchema } from '@app/contracts';
import { startRuntime } from '../src/recovery/runtime.js';
import { LocalReviewService } from '../src/reviews/service.js';
import { PgDraftStore } from '../src/drafts/store.js';
import { PgReviewStore } from '../src/runs/review-store.js';
import { runGit } from '../src/git/command.js';
import { connectTestDb, insertTask, insertWorkspace, insertRun, sessionCookie, testDatabaseUrl } from './helpers.js';

/** Presents the same session an ordinary request would; see capture.test.ts. */
class AuthenticatedWebSocket extends WebSocket {
  constructor(address: string, protocols?: string | string[]) {
    super(address, protocols, { headers: sessionCookie() });
  }
}
import { testConfig, authenticateRuntime } from './app-helpers.js';

let db: ReturnType<typeof connectTestDb>, root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let workspaceId: string, taskId: string;
const path = 'documents/shared.md';
const url = () => `/api/workspaces/${workspaceId}/tasks/${taskId}/review`;
const reviewUrl = (id: string) => `/api/workspaces/${workspaceId}/reviews/${id}`;
const prepare = () => runtime.app.inject({ method: 'POST', url: url(), payload: {} });
const peers: Array<{ provider: WebsocketProvider; doc: Y.Doc }> = [];

beforeEach(async () => {
  db = connectTestDb(); root = await mkdtemp(join(tmpdir(), 'd06-api-'));
  workspaceId = await insertWorkspace(db.db);
  taskId = await insertTask(db.db, workspaceId, { kind: 'manual_edit', manual_source_path: path });
  runtime = await startRuntime({ config: testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl() }),
    listen: { host: '127.0.0.1', port: 0 } });
  await authenticateRuntime(runtime.app, db.db);
  await runtime.git.checkpoint({ workspaceId, taskId, files: [{ path, text: 'human draft\n' }] });
});
afterEach(async () => {
  for (const p of peers.splice(0)) { p.provider.destroy(); p.doc.destroy(); }
  vi.restoreAllMocks(); await runtime?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
});

async function conflict() {
  const repository = (await runtime.git.ensureRepository(workspaceId)).repositoryPath;
  const other = await runtime.git.checkpoint({ workspaceId, taskId: randomUUID(), files: [{ path, text: 'approved draft\n' }] });
  await runGit(['--git-dir', repository, 'update-ref', 'refs/heads/main', other.commitSha]);
  const response = await prepare(); expect(response.statusCode, response.body).toBe(200);
  return reviewDetailSchema.parse(response.json());
}

describe('D06 review HTTP and persistence', { timeout: 60_000 }, () => {
  it('prepares a contributor manual review, stores exact sources, and serves durable diff/preview reads', async () => {
    const spy = vi.spyOn(runtime.collaboration, 'capture');
    const response = await prepare(); expect(response.statusCode, response.body).toBe(200);
    const result = reviewDetailSchema.parse(response.json());
    expect(result.review.status).toBe('ready'); expect(result.review.runId).toBeNull();
    expect(result.review.source).toMatchObject({ taskVersion: 1, guidanceVersion: 1, resultSha: null, documentRevisions: {} });
    expect(spy).toHaveBeenCalledWith({ workspaceId, taskId });
    const row = await db.db.selectFrom('reviews').selectAll().where('id', '=', result.review.id).executeTakeFirstOrThrow();
    expect(row.candidate_sha).toBe(result.candidateSha); expect(row.human_sha).toBe(result.review.source.humanSha);
    expect(row.context_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.changedFiles).toMatchObject([{ path, changeKind: 'added' }]);
    expect(result.changedFiles[0]!.diff).toContain('+human draft');
    const detail = await runtime.app.inject({ method: 'GET', url: reviewUrl(result.review.id) });
    expect(detail.json()).toEqual(result);
    const diff = await runtime.app.inject({ method: 'GET', url: `${reviewUrl(result.review.id)}/diff` });
    expect(diff.json().changedFiles).toEqual(result.changedFiles);
    const detailRead = vi.spyOn(runtime.git, 'readReview');
    const preview = await runtime.app.inject({ method: 'GET', url: `${reviewUrl(result.review.id)}/preview?path=${path}` });
    expect(detailRead).not.toHaveBeenCalled();
    expect(preview.json()).toMatchObject({ candidateSha: result.candidateSha, text: 'human draft\n' });
    expect(response.body).not.toContain(root);
    const events = await db.db.selectFrom('task_events').selectAll().where('task_id', '=', taskId).where('type', '=', 'review.ready').execute();
    expect(events).toHaveLength(1); expect(events[0]!.payload).toMatchObject({ candidateSha: result.candidateSha });
    const fresh = new LocalReviewService({ db: db.db, git: runtime.git, collaboration: runtime.collaboration });
    expect(await fresh.read(workspaceId, result.review.id)).toEqual(result);
  });

  it('captures accepted live edits with exact revisions and keeps both clients editing afterward', async () => {
    const drafts = new PgDraftStore({ db: db.db });
    const draft = await drafts.openForTask(workspaceId, taskId, path);
    const base = `ws://127.0.0.1:${(runtime.app.server.address() as { port: number }).port}`;
    const room = { workspaceId, taskId, draftFileId: draft.id, epoch: draft.epoch };
    const connect = async () => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(base, liveRoomPath(room).slice(1), doc, { WebSocketPolyfill: AuthenticatedWebSocket, disableBc: true });
      const acks: number[] = [];
      provider.messageHandlers[LIVE_MESSAGE_ACK] = (_encoder, decoder) => {
        const kind = decoding.readVarUint(decoder), revision = decoding.readVarUint(decoder);
        if (kind === LIVE_ACK_ACCEPTED) acks.push(revision);
      };
      peers.push({ doc, provider });
      await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 10_000 });
      return { doc, provider, acks, text: doc.getText(LIVE_TEXT_NAME) };
    };
    const a = await connect(), b = await connect();
    a.text.insert(a.text.length, 'live'); await vi.waitFor(() => expect(a.acks).toContain(1));
    const response = await prepare(); expect(response.statusCode, response.body).toBe(200);
    const detail = reviewDetailSchema.parse(response.json());
    expect(detail.review.source.documentRevisions).toEqual({ [draft.id]: 1 });
    const preview = await runtime.reviews.preview(workspaceId, detail.review.id, path);
    expect(preview.text).toBe('human draft\nlive');
    a.text.insert(a.text.length, ' later');
    await vi.waitFor(() => expect(b.text.toString()).toBe('human draft\nlive later'));
    expect((await runtime.reviews.preview(workspaceId, detail.review.id, path)).text).toBe('human draft\nlive');
    expect((await drafts.load(workspaceId, draft.id))!.draftFile.status).toBe('active');
  });

  it('persists conflicts atomically, resolves without owner credentials, and rejects stale resolution requests', async () => {
    const first = await conflict();
    expect(first.review.status).toBe('conflict'); expect(first.candidateComplete).toBe(false);
    expect(first.conflicts[0]).toMatchObject({ path, stage: 'task_main' });
    const store = new PgReviewStore({ db: db.db });
    await expect(store.claimForApply(first.review.id, first.candidateSha)).rejects.toMatchObject({ code: 'REVIEW_STALE' });
    const payload = { expectedCandidateSha: first.candidateSha, resolutions: [{ path, choice: 'manual', text: 'resolved\n' }] };
    const [a, b] = await Promise.all([1, 2].map(() => runtime.app.inject({ method: 'POST', url: `${reviewUrl(first.review.id)}/resolve`, payload })));
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const next = reviewDetailSchema.parse((a.statusCode === 200 ? a : b).json());
    expect(next.candidateSha).not.toBe(first.candidateSha); expect(next.review.status).toBe('ready');
    expect(next.review.source).toEqual(first.review.source);
    expect((await runtime.reviews.preview(workspaceId, first.review.id, path)).text).toBe('resolved\n');
    expect((await runtime.git.readReview({ workspaceId, reviewId: first.review.id, candidateSha: first.candidateSha })).data.candidateComplete).toBe(false);
    const main = (await runtime.git.initialize(workspaceId)).mainSha;
    expect(main).toBe(first.review.source.mainSha);
  });

  it('validates route/body scope and rejects forged sources and malformed Apply', async () => {
    const other = await insertWorkspace(db.db);
    const first = await conflict();
    for (const target of [url().replace(taskId, 'bad'), url().replace(workspaceId, 'bad')]) {
      expect((await runtime.app.inject({ method: 'POST', url: target, payload: {} })).statusCode).toBe(400);
    }
    for (const field of ['source', 'mainSha', 'documentRevisions', 'files', 'isOwner', 'runId']) {
      const r = await runtime.app.inject({ method: 'POST', url: url(), payload: { [field]: 'forged' } });
      expect(r.statusCode).toBe(400);
    }
    expect((await runtime.app.inject({ method: 'POST', url: url().replace(workspaceId, other), payload: {} })).statusCode).toBe(404);
    for (const suffix of ['', '/diff', `/preview?path=${path}`]) {
      expect((await runtime.app.inject({ method: 'GET', url: reviewUrl(first.review.id).replace(workspaceId, other) + suffix })).statusCode).toBe(404);
    }
    const resolve = await runtime.app.inject({ method: 'POST', url: `${reviewUrl(first.review.id).replace(workspaceId, other)}/resolve`,
      payload: { expectedCandidateSha: first.candidateSha, resolutions: [{ path, choice: 'manual', text: 'bad' }] } });
    expect(resolve.statusCode).toBe(404);
    const unsafe = await runtime.app.inject({ method: 'GET', url: `${reviewUrl(first.review.id)}/preview?path=../secret` });
    expect(unsafe.statusCode).toBe(400);
    expect((await runtime.app.inject({ method: 'POST', url: `${reviewUrl(first.review.id)}/apply`, payload: {} })).statusCode).toBe(400);
  });

  it('implements the shared prepare and resolve service signatures', async () => {
    const first = await conflict();
    const ready = await runtime.reviews.resolve({ workspaceId, reviewId: first.review.id,
      expectedCandidateSha: first.candidateSha, resolutions: [{ path, choice: 'approved_main' }] });
    expect(ready.status).toBe('ready'); expect(ready.source).toEqual(first.review.source);
    const prepared = await runtime.reviews.prepare({ workspaceId, taskId });
    expect(prepared.id).not.toBe(ready.id); expect(prepared.status).toBe('conflict');
  });

  it('records the authoritative completed result and captured context, rejecting a mismatched Git head', async () => {
    // PgRunStore.settle clears active_run_id but leaves the task working until review handoff.
    taskId = await insertTask(db.db, workspaceId, { status: 'working' });
    const start = await runtime.git.checkpoint({ workspaceId, taskId, files: [{ path, text: 'start' }] });
    const runId = await insertRun(db.db, workspaceId, taskId, { status: 'completed' });
    const agentInstanceId = randomUUID();
    await runtime.git.createResult({ workspaceId, runId, baseSha: start.commitSha });
    await runtime.git.createWorker({ workspaceId, agentInstanceId, baseSha: start.commitSha });
    const before = await runtime.git.readText({ workspaceId, target: { kind: 'commit', commitSha: start.commitSha }, path, allowedPaths: [path] });
    await runtime.git.applyWorkerChanges({ workspaceId, agentInstanceId, allowedWritePaths: [path], changes: [{ path, expectedHash: before.hash, newText: 'agent output' }] });
    const integrated = await runtime.git.integrate({ workspaceId, runId, agentInstanceId });
    const manifest = { taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [], approvedPaths: [],
      approvedCommitSha: (await runtime.git.initialize(workspaceId)).mainSha, draftCheckpointSha: start.commitSha, draftFileHashes: {} };
    await db.db.updateTable('runs').set({ input_snapshot_sha: start.commitSha, result_head_sha: integrated.resultSha, context_manifest: manifest })
      .where('id', '=', runId).execute();
    const response = await prepare(); expect(response.statusCode, response.body).toBe(200);
    const detail = reviewDetailSchema.parse(response.json());
    expect(detail.review.runId).toBe(runId); expect(detail.review.source.resultSha).toBe(integrated.resultSha);
    expect((await runtime.reviews.preview(workspaceId, detail.review.id, path)).text).toBe('agent output');
    await db.db.updateTable('runs').set({ result_head_sha: start.commitSha }).where('id', '=', runId).execute();
    const bad = await prepare(); expect(bad.statusCode).toBe(409); expect(bad.json().error.code).toBe('INPUT_CONFLICT');
  });

  it('rejects unfinished agent tasks and capture failures without exposing ready metadata', async () => {
    const agentTask = await insertTask(db.db, workspaceId);
    expect((await runtime.app.inject({ method: 'POST', url: url().replace(taskId, agentTask), payload: {} })).statusCode).toBe(409);
    const spy = vi.spyOn(runtime.collaboration, 'capture').mockRejectedValueOnce(new Error('capture failed'));
    expect((await prepare()).statusCode).toBe(500); spy.mockRestore();
    const gitFailure = vi.spyOn(runtime.git, 'buildReview').mockRejectedValueOnce(new Error('Git failed'));
    expect((await prepare()).statusCode).toBe(500); gitFailure.mockRestore();
    const rows = await db.db.selectFrom('reviews').selectAll().where('task_id', '=', taskId).execute();
    expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe('building'); expect(rows[0]!.candidate_sha).toBeNull();
    expect((await prepare()).statusCode).toBe(200);
  });

  it('rolls back ready state when event insertion fails, preserving the private candidate for inspection', async () => {
    const failing = db.db.withPlugin({
      transformQuery(args) {
        if (args.node.kind === 'InsertQueryNode' && JSON.stringify(args.node.into).includes('task_events')) throw new Error('event insert failed');
        return args.node;
      },
      async transformResult(args) { return args.result; },
    });
    const reviews = new LocalReviewService({ db: failing, git: runtime.git, collaboration: runtime.collaboration });
    const build = vi.spyOn(runtime.git, 'buildReview');
    await expect(reviews.prepare(workspaceId, taskId)).rejects.toThrow('event insert failed');
    const record = await db.db.selectFrom('reviews').selectAll().where('task_id', '=', taskId).executeTakeFirstOrThrow();
    expect(record.status).toBe('building'); expect(record.candidate_sha).toBeNull();
    const result = await build.mock.results[0]!.value;
    expect((await runtime.git.readReview({ workspaceId, reviewId: record.id, candidateSha: result.candidateSha })).data.candidateComplete).toBe(true);
  });

  it('rejects requirements changed during construction without making the candidate ready', async () => {
    const build = runtime.git.buildReview.bind(runtime.git);
    vi.spyOn(runtime.git, 'buildReview').mockImplementationOnce(async (input) => {
      const result = await build(input);
      await db.db.updateTable('tasks').set({ version: 2, outcome: 'revised requirements' }).where('id', '=', taskId).execute();
      return result;
    });
    const response = await prepare();
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('INPUT_CONFLICT');
    const rows = await db.db.selectFrom('reviews').selectAll().where('task_id', '=', taskId).execute();
    expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe('building'); expect(rows[0]!.task_version).toBe(1);
    const ready = await db.db.selectFrom('task_events').select('id').where('task_id', '=', taskId).where('type', '=', 'review.ready').execute();
    expect(ready).toHaveLength(0);
  });

  it('hashes the material union and current requirements separately from the draft-only capture digest', async () => {
    const bytes = createHash('sha256').update('source').digest();
    const material = await db.db.insertInto('materials').values({ workspace_id: workspaceId, filename: 'source.txt', object_key: 'test',
      sha256: bytes, byte_size: 6, guest_label: 'Guest' }).returning('id').executeTakeFirstOrThrow();
    await db.db.insertInto('material_links').values({ workspace_id: workspaceId, task_id: taskId, material_id: material.id, discussion_entry_id: null }).execute();
    const response = await prepare(); expect(response.statusCode, response.body).toBe(200);
    const detail = reviewDetailSchema.parse(response.json());
    const { artifact } = await runtime.git.readReview({ workspaceId, reviewId: detail.review.id, candidateSha: detail.candidateSha });
    expect(artifact.context.materials).toEqual([{ materialId: material.id, sha256: bytes.toString('hex') }]);
    expect(detail.review.source.contextHash).not.toBe((artifact.context.draft as { contextHash: string }).contextHash);
    expect(artifact.source).toEqual(detail.review.source);
  });
});
