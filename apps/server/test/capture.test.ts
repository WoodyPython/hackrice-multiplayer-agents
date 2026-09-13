import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_ACK_ACCEPTED, LIVE_ACK_PERSISTED, LIVE_MESSAGE_ACK, LIVE_TEXT_NAME,
  draftCaptureSchema, liveRoomPath, type DraftCapture, type LiveRoomId,
} from '@app/contracts';
import { LiveDocumentCoordinator } from '../src/collaboration/coordinator.js';
import { PgCheckpointStore } from '../src/collaboration/checkpoint-store.js';
import { attachLiveDocuments } from '../src/collaboration/server.js';
import { registerCheckpointRoutes } from '../src/collaboration/routes.js';
import { TaskDocumentGate } from '../src/collaboration/gate.js';
import { PgDraftStore } from '../src/drafts/store.js';
import { LocalGitService } from '../src/git/service.js';
import { buildApp } from '../src/http/app.js';
import { startRuntime } from '../src/recovery/runtime.js';
import { testConfig, authenticateRuntime } from './app-helpers.js';
import { connectTestDb, insertTask, insertWorkspace, sessionCookie, testDatabaseUrl } from './helpers.js';

let db: ReturnType<typeof connectTestDb>;
let store: PgDraftStore;
let checkpoints: PgCheckpointStore;
let git: LocalGitService;
let coordinator: LiveDocumentCoordinator;
let app: FastifyInstance;
let live: ReturnType<typeof attachLiveDocuments>;
let root: string;
let id: LiveRoomId;
let base: string;
const peers: Array<{ provider: WebsocketProvider; doc: Y.Doc }> = [];
const releases: Array<() => void> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}

beforeEach(async () => {
  db = connectTestDb();
  root = await mkdtemp(join(tmpdir(), 'd04-capture-'));
  store = new PgDraftStore({ db: db.db });
  checkpoints = new PgCheckpointStore(db.db);
  git = new LocalGitService(root);
  const workspaceId = await insertWorkspace(db.db);
  const taskId = await insertTask(db.db, workspaceId);
  const draft = await store.openForTask(workspaceId, taskId, 'documents/shared.md');
  id = { workspaceId, taskId, draftFileId: draft.id, epoch: draft.epoch };
  const deps = { drafts: store, git, debounceMs: 60_000 };
  coordinator = new LiveDocumentCoordinator(deps, { drafts: store, git, checkpoints });
  app = await buildApp({ db: db.db, config: testConfig({ gitDataRoot: root }) });
  // Checkpoint routes are workspace routes, so they sit behind the gate now.
  await authenticateRuntime(app, db.db);
  await registerCheckpointRoutes(app, coordinator);
  live = attachLiveDocuments(app.server, deps, coordinator);
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const peer of peers.splice(0)) { peer.provider.destroy(); peer.doc.destroy(); }
  vi.restoreAllMocks();
  await live?.close();
  await app?.close();
  await db.close();
  await rm(root, { recursive: true, force: true });
});

/**
 * The live socket authorizes from a cookie, because a browser cannot set
 * headers on a WebSocket handshake. `ws` can, which is how the test client
 * presents the same session an ordinary request would.
 */
class AuthenticatedWebSocket extends WebSocket {
  constructor(address: string, protocols?: string | string[]) {
    super(address, protocols, { headers: sessionCookie() });
  }
}

function client(room = id) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(base, liveRoomPath(room).slice(1), doc, {
    WebSocketPolyfill: AuthenticatedWebSocket, connect: false, disableBc: true,
  });
  const acks: Array<{ kind: number; revision: number }> = [];
  provider.messageHandlers[LIVE_MESSAGE_ACK] = (_encoder, decoder) => {
    acks.push({ kind: decoding.readVarUint(decoder), revision: decoding.readVarUint(decoder) });
  };
  provider.on('connection-close', (event: { code?: number } | null) => {
    if (event?.code === 4409 || event?.code === 1008) provider.shouldConnect = false;
  });
  peers.push({ provider, doc });
  provider.connect();
  return { provider, doc, text: doc.getText(LIVE_TEXT_NAME), acks };
}

async function connect(room = id) {
  const peer = client(room);
  await vi.waitFor(() => expect(peer.provider.synced).toBe(true), { timeout: 10_000 });
  return peer;
}

async function accepted(peer: ReturnType<typeof client>, revision: number) {
  await vi.waitFor(() => expect(peer.acks).toContainEqual({ kind: LIVE_ACK_ACCEPTED, revision }));
}

const capture = () => coordinator.capture(id);
const records = () => db.db.selectFrom('draft_checkpoints').selectAll().where('task_id', '=', id.taskId).execute();
const events = () => db.db.selectFrom('task_events').selectAll().where('task_id', '=', id.taskId)
  .where('type', '=', 'draft.checkpointed').execute();
const textAt = async (sha: string, path = 'documents/shared.md') => (await git.readText({
  workspaceId: id.workspaceId, target: { kind: 'commit', commitSha: sha }, path, allowedPaths: [path],
})).text;

async function persistedText(draftId = id.draftFileId) {
  const loaded = await store.load(id.workspaceId, draftId);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, loaded!.yjsState!);
    return { text: doc.getText(LIVE_TEXT_NAME).toString(), revision: loaded!.draftFile.persistedRevision };
  } finally { doc.destroy(); }
}

function holdCheckpoint(fail = false) {
  const entered = deferred(), finish = deferred();
  const original = git.withDraftCapture.bind(git);
  const spy = vi.spyOn(git, 'withDraftCapture').mockImplementation((input, operation) => original(input, (scope) => operation({
    ...scope, checkpoint: async (files) => {
      entered.resolve();
      await finish.promise;
      if (fail) throw new Error('private storage path and secret');
      return scope.checkpoint(files);
    },
  })));
  return { entered, finish, spy };
}

describe('D04 capture', { timeout: 120_000 }, () => {
  it('flushes accepted edits and binds exact Git text, revisions, digest and durable event', async () => {
    const main = (await git.initialize(id.workspaceId)).mainSha;
    const a = await connect(), b = await connect();
    a.text.insert(0, 'accepted draft');
    await accepted(a, 1);
    expect((await store.load(id.workspaceId, id.draftFileId))!.draftFile.persistedRevision).toBe(0);
    const result = draftCaptureSchema.parse(await capture());
    expect(result.documentRevisions).toEqual({ [id.draftFileId]: 1 });
    expect(await textAt(result.checkpointSha)).toBe('accepted draft');
    expect(await persistedText()).toEqual({ text: 'accepted draft', revision: 1 });
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 }));
    expect(result.contextHash).toBe(createHash('sha256').update(JSON.stringify({
      taskId: id.taskId, checkpointSha: result.checkpointSha, documentRevisions: result.documentRevisions,
    })).digest('hex'));
    const rows = await records(), emitted = await events();
    expect(rows).toHaveLength(1); expect(emitted).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commit_sha: result.checkpointSha, document_revisions: result.documentRevisions });
    expect(emitted[0]).toMatchObject({ event_key: `checkpoint:${rows[0]!.id}`, payload: {
      checkpointId: rows[0]!.id, commitSha: result.checkpointSha,
      documentRevisions: result.documentRevisions, contextHash: result.contextHash,
    } });
    expect((await git.initialize(id.workspaceId)).mainSha).toBe(main);
    expect(a.provider.synced).toBe(true); expect(b.provider.synced).toBe(true);
    expect(b.text.toString()).toBe('accepted draft');
    a.text.insert(a.text.length, ' after'); await accepted(a, 2);
    expect(await textAt(result.checkpointSha)).toBe('accepted draft');
    expect(a.text.toString()).toBe('accepted draft after');
  });

  it('captures loaded, disconnected, persisted and never-initialized documents and preserves omitted files', async () => {
    await git.checkpoint({ ...id, files: [
      { path: 'documents/shared.md', text: 'Git seed' },
      { path: 'documents/retained.md', text: 'not an active document' },
      { path: 'code/seed.ts', text: 'const seed = 1;' },
    ] });
    const saved = await store.openForTask(id.workspaceId, id.taskId, 'documents/saved.md');
    const absent = await store.openForTask(id.workspaceId, id.taskId, 'documents/empty.md');
    const seeded = await store.openForTask(id.workspaceId, id.taskId, 'code/seed.ts');
    const b = await connect({ ...id, draftFileId: saved.id });
    b.text.insert(0, 'offline saved'); await accepted(b, 1); b.provider.disconnect();
    await vi.waitFor(async () => expect((await store.load(id.workspaceId, saved.id))!.draftFile.persistedRevision).toBe(1));
    const a = await connect(); expect(a.text.toString()).toBe('Git seed');
    const result = await capture();
    expect(result.documentRevisions).toEqual({ [id.draftFileId]: 0, [saved.id]: 1, [absent.id]: 0, [seeded.id]: 0 });
    for (const [path, text] of Object.entries({
      'documents/shared.md': 'Git seed', 'documents/saved.md': 'offline saved',
      'documents/empty.md': '', 'code/seed.ts': 'const seed = 1;', 'documents/retained.md': 'not an active document',
    })) expect(await textAt(result.checkpointSha, path)).toBe(text);
    expect(await persistedText(absent.id)).toEqual({ text: '', revision: 0 });
    const firstJoin = await connect({ ...id, draftFileId: seeded.id });
    expect(firstJoin.text.toString()).toBe('const seed = 1;');
    expect(await coordinator.capture({ workspaceId: id.workspaceId.toUpperCase(), taskId: id.taskId.toUpperCase() })).toEqual(result);
  });

  it('queues typing during capture and includes it in the following capture without resetting clients', async () => {
    const a = await connect(), b = await connect();
    a.text.insert(0, 'first'); await accepted(a, 1);
    const acquired = await coordinator.acquire(id); releases.push(acquired.release);
    const blocked = holdCheckpoint();
    const first = capture(); await blocked.entered.promise;
    const arrived = once([...acquired.room.connections.keys()][0]!, 'message');
    a.text.insert(5, ' second'); await arrived;
    expect(acquired.room.revision).toBe(1);
    expect(acquired.room.busy).toBe(true);
    expect(b.text.toString()).toBe('first');
    const second = capture();
    blocked.finish.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one.documentRevisions[id.draftFileId]).toBe(1);
    expect(two.documentRevisions[id.draftFileId]).toBe(2);
    expect(await textAt(one.checkpointSha)).toBe('first');
    expect(await textAt(two.checkpointSha)).toBe('first second');
    await vi.waitFor(() => expect(b.text.toString()).toBe('first second'));
  });

  it('does not hold other tasks typing while serializing Git operations in the same workspace', async () => {
    const a = await connect(); a.text.insert(0, 'capture'); await accepted(a, 1);
    const otherTask = await insertTask(db.db, id.workspaceId);
    const draft = await store.openForTask(id.workspaceId, otherTask, 'documents/other.md');
    const b = await connect({ ...id, taskId: otherTask, draftFileId: draft.id });
    const blocked = holdCheckpoint();
    const pending = capture(); await blocked.entered.promise;
    let gitFinished = false;
    const otherGit = git.checkpoint({ workspaceId: id.workspaceId, taskId: otherTask, files: [] }).then(() => { gitFinished = true; });
    b.text.insert(0, 'independent'); await accepted(b, 1);
    expect(gitFinished).toBe(false);
    blocked.finish.resolve(); await Promise.all([pending, otherGit]);
    expect(gitFinished).toBe(true);
  });

  it('preserves revisions for deletion-only changes and text-identical checkpoints', async () => {
    const a = await connect(); a.text.insert(0, 'x'); await accepted(a, 1);
    const one = await capture();
    a.text.delete(0, 1); await accepted(a, 2); a.text.insert(0, 'x'); await accepted(a, 3);
    const two = await capture();
    expect(two.checkpointSha).toBe(one.checkpointSha);
    expect(two.documentRevisions[id.draftFileId]).toBe(3);
    expect(two.contextHash).not.toBe(one.contextHash);
    a.text.delete(0, 1); await accepted(a, 4);
    expect(await textAt((await capture()).checkpointSha)).toBe('');
  });

  it('serializes repeated concurrent captures with complete matching records', async () => {
    const a = await connect();
    for (let round = 1; round <= 4; round++) {
      a.text.insert(a.text.length, `${round}`); await accepted(a, round);
      const results = await Promise.all([capture(), capture(), capture()]);
      for (const result of results) {
        expect(result).toEqual(results[0]);
        expect(result.documentRevisions[id.draftFileId]).toBe(round);
        expect(await textAt(result.checkpointSha)).toBe(a.text.toString());
      }
    }
    expect(await records()).toHaveLength(12); expect(await events()).toHaveLength(12);
  });

  it('fails on persistence error, preserves accepted edits, releases the gate and permits retry', async () => {
    const a = await connect(); a.text.insert(0, 'kept'); await accepted(a, 1);
    const failed = vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('secret connection string'));
    await expect(capture()).rejects.toMatchObject({ code: 'DRAFT_NOT_SAVED' });
    expect(await records()).toHaveLength(0); expect(await events()).toHaveLength(0);
    expect(a.acks).not.toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 });
    failed.mockRestore();
    a.text.insert(4, ' after failure'); await accepted(a, 2);
    expect(await textAt((await capture()).checkpointSha)).toBe('kept after failure');
  });

  it('releases queued updates after Git failure without recording false success', async () => {
    const a = await connect(); a.text.insert(0, 'saved'); await accepted(a, 1);
    const acquired = await coordinator.acquire(id); releases.push(acquired.release);
    const blocked = holdCheckpoint(true);
    const result = capture().catch((error: unknown) => error);
    await blocked.entered.promise;
    const arrived = once([...acquired.room.connections.keys()][0]!, 'message');
    a.text.insert(5, ' next'); await arrived;
    blocked.finish.resolve();
    expect(await result).toMatchObject({ code: 'DRAFT_NOT_SAVED' });
    await accepted(a, 2);
    expect(await records()).toHaveLength(0); expect(await events()).toHaveLength(0);
    blocked.spy.mockRestore();
    expect(await textAt((await capture()).checkpointSha)).toBe('saved next');
  });

  it('rolls back checkpoint metadata if its event fails, retaining Git for retry', async () => {
    const a = await connect(); a.text.insert(0, 'committed'); await accepted(a, 1);
    let committed!: DraftCapture;
    const record = checkpoints.record.bind(checkpoints);
    const spy = vi.spyOn(checkpoints, 'record').mockImplementationOnce(async (workspaceId, result) => {
      committed = result;
      // Kysely plugin fails precisely at the event INSERT, after checkpoint INSERT.
      const failing = db.db.withPlugin({
        transformQuery(args) {
          const query = args.node;
          if (query.kind === 'InsertQueryNode' && JSON.stringify(query.into).includes('task_events')) {
            throw new Error('private database error');
          }
          return query;
        },
        async transformResult(args) { return args.result; },
      });
      await new PgCheckpointStore(failing).record(workspaceId, result);
    });
    await expect(capture()).rejects.toMatchObject({ code: 'DRAFT_NOT_SAVED' });
    expect(await records()).toHaveLength(0); expect(await events()).toHaveLength(0);
    expect(await textAt(committed.checkpointSha)).toBe('committed');
    spy.mockImplementation(record);
    expect(await capture()).toEqual(committed);
    expect(await records()).toHaveLength(1); expect(await events()).toHaveLength(1);
  });

  it('captures while a first join is waiting for Git without deadlocking or duplicating its seed', async () => {
    await git.checkpoint({ ...id, files: [{ path: 'documents/shared.md', text: 'seed once' }] });
    const reading = deferred(), resume = deferred();
    const read = git.readText.bind(git);
    vi.spyOn(git, 'readText').mockImplementationOnce(async (input) => {
      reading.resolve(); await resume.promise; return read(input);
    });
    const a = client(); await reading.promise;
    const result = await capture();
    resume.resolve();
    await vi.waitFor(() => expect(a.provider.synced).toBe(true), { timeout: 10_000 });
    expect(a.text.toString()).toBe('seed once');
    expect(await textAt(result.checkpointSha)).toBe('seed once');
  });

  it.each(['clean', 'dirty', 'during Git'])('rejects a closed epoch (%s) without recording a checkpoint', async (when) => {
    const a = await connect();
    if (when !== 'clean') { a.text.insert(0, 'edit'); await accepted(a, 1); }
    if (when === 'during Git') {
      const blocked = holdCheckpoint();
      const pending = capture().catch((error: unknown) => error);
      await blocked.entered.promise;
      await store.closeEpoch(id.workspaceId, id.taskId);
      blocked.finish.resolve();
      expect(await pending).toMatchObject({ code: 'DOCUMENT_EPOCH_CLOSED' });
    } else {
      await store.closeEpoch(id.workspaceId, id.taskId);
      await expect(capture()).rejects.toMatchObject({ code: 'DOCUMENT_EPOCH_CLOSED' });
    }
    expect(await records()).toHaveLength(0); expect(await events()).toHaveLength(0);
  });

  it('rejects corrupt stored state without a Git checkpoint or raw error disclosure', async () => {
    await db.db.updateTable('draft_files').set({ yjs_state: Buffer.from([255]), state_vector: Buffer.from([0]) })
      .where('id', '=', id.draftFileId).execute();
    const response = await app.inject({ method: 'POST', url: `/api/workspaces/${id.workspaceId}/tasks/${id.taskId}/checkpoint` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DRAFT_NOT_SAVED');
    expect(response.body).not.toContain(root);
    expect(await records()).toHaveLength(0);
  });

  it('captures a task with no documents without manufacturing a document or deleting Git files', async () => {
    const taskId = await insertTask(db.db, id.workspaceId);
    const first = await git.checkpoint({ workspaceId: id.workspaceId, taskId, files: [{ path: 'documents/retained.md', text: 'keep' }] });
    const result = await coordinator.capture({ workspaceId: id.workspaceId, taskId });
    expect(result.documentRevisions).toEqual({}); expect(result.checkpointSha).toBe(first.commitSha);
    expect(await store.listActiveForTask(id.workspaceId, taskId)).toEqual([]);
  });

  it('drains an in-flight capture and queued edits before shutting down', async () => {
    const a = await connect(); a.text.insert(0, 'boundary'); await accepted(a, 1);
    const acquired = await coordinator.acquire(id); releases.push(acquired.release);
    const blocked = holdCheckpoint();
    const pending = capture(); await blocked.entered.promise;
    const arrived = once([...acquired.room.connections.keys()][0]!, 'message');
    a.text.insert(8, ' later'); await arrived;
    a.provider.shouldConnect = false;
    const closing = live.close();
    await expect(capture()).rejects.toMatchObject({ code: 'DRAFT_NOT_SAVED' });
    blocked.finish.resolve();
    const result = await pending; await closing;
    expect(result.documentRevisions[id.draftFileId]).toBe(1);
    expect(await textAt(result.checkpointSha)).toBe('boundary');
    expect(await persistedText()).toEqual({ text: 'boundary later', revision: 2 });
  });
});

describe('D04 checkpoint HTTP', () => {
  const url = () => `/api/workspaces/${id.workspaceId}/tasks/${id.taskId}/checkpoint`;

  it('allows contributor capture, validates identifiers and refuses cross-task/workspace lookup', async () => {
    const result = await app.inject({ method: 'POST', url: url(), payload: {} });
    expect(result.statusCode, result.body).toBe(200); expect(draftCaptureSchema.safeParse(result.json()).success).toBe(true);
    for (const target of [url().replace(id.taskId, 'bad'), url().replace(id.workspaceId, 'bad')]) {
      const response = await app.inject({ method: 'POST', url: target });
      expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('VALIDATION_FAILED');
    }
    const workspace = await insertWorkspace(db.db);
    for (const target of [url().replace(id.workspaceId, workspace), url().replace(id.taskId, randomUUID())]) {
      const response = await app.inject({ method: 'POST', url: target });
      expect(response.statusCode).toBe(404); expect(response.json().error.code).toBe('TASK_NOT_FOUND');
    }
  });

  it.each(['yjsState', 'files', 'path', 'documentRevisions', 'isOwner', 'ownerKey'])('rejects the untrusted %s payload field', async (field) => {
    const response = await app.inject({ method: 'POST', url: url(), payload: { [field]: 'untrusted' } });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(await records()).toHaveLength(0);
  });

  it('registers capture on the default runtime and shares its WebSocket coordinator', async () => {
    const runtime = await startRuntime({
      config: testConfig({ gitDataRoot: join(root, 'runtime'), DATABASE_URL: testDatabaseUrl() }),
      listen: { host: '127.0.0.1', port: 0 },
    });
    await authenticateRuntime(runtime.app, db.db);
    try {
      base = `ws://127.0.0.1:${(runtime.app.server.address() as { port: number }).port}`;
      const a = await connect(); a.text.insert(0, 'runtime draft'); await accepted(a, 1);
      const response = await runtime.app.inject({ method: 'POST', url: url() });
      expect(response.statusCode, response.body).toBe(200);
      const result = draftCaptureSchema.parse(response.json());
      expect(result.documentRevisions[id.draftFileId]).toBe(1);
      expect(await runtime.collaboration.capture(id)).toEqual(result);
      expect((await runtime.git.readText({ workspaceId: id.workspaceId, target: { kind: 'commit', commitSha: result.checkpointSha },
        path: 'documents/shared.md', allowedPaths: ['documents/shared.md'] })).text).toBe('runtime draft');
      a.provider.shouldConnect = false;
    } finally { await runtime.close(); }
  });
});

describe('task document gate', () => {
  it('runs queued updates before a later capture and always releases after failure', async () => {
    const gate = new TaskDocumentGate(), blocker = deferred();
    const order: string[] = [];
    const first = gate.run(id.taskId, () => blocker.promise);
    const update = gate.run(id.taskId.toUpperCase(), () => { order.push('update'); throw new Error('bad frame'); }).catch(() => undefined);
    const boundary = gate.run(id.taskId, () => { order.push('capture'); });
    await gate.run(randomUUID(), () => { order.push('other task'); });
    blocker.resolve(); await Promise.all([first, update, boundary]);
    expect(order).toEqual(['other task', 'update', 'capture']);
  });
});
