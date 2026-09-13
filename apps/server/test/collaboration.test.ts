import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import { WebsocketProvider } from 'y-websocket';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, LIVE_ACK_ACCEPTED, LIVE_ACK_PERSISTED, LIVE_MESSAGE_ACK,
  LIVE_MESSAGE_SYNC, LIVE_TEXT_NAME, liveRoomPath, canWrite, type LiveRoomId,
} from '@app/contracts';
import { attachLiveDocuments, type LiveAuthorizer, type LiveDocumentDeps } from '../src/collaboration/server.js';
import { SessionStore } from '../src/auth/sessions.js';
import { readSessionCookie } from '../src/auth/authorize.js';
import { MAX_LIVE_MESSAGE_BYTES } from '../src/collaboration/room.js';
import { PgDraftStore } from '../src/drafts/store.js';
import { LocalGitService } from '../src/git/service.js';
import { startRuntime } from '../src/recovery/runtime.js';
import { testConfig, authenticateRuntime } from './app-helpers.js';
import { connectTestDb, insertTask, insertWorkspace, sessionCookie, testDatabaseUrl, TEST_USER_ID } from './helpers.js';

let db: ReturnType<typeof connectTestDb>;
let store: PgDraftStore;
let id: LiveRoomId;
let server: Server;
let live: ReturnType<typeof attachLiveDocuments>;
let base: string;
let root: string | undefined;
let git: LiveDocumentDeps['git'];
let logs: ReturnType<typeof vi.fn>;
const peers: Array<{ provider: WebsocketProvider; doc: Y.Doc }> = [];
const sockets: WebSocket[] = [];
const unblock: Array<() => void> = [];

async function listen(deps: Partial<LiveDocumentDeps> = {}, authorize?: LiveAuthorizer) {
  server = createServer();
  live = attachLiveDocuments(server, { drafts: store, git, debounceMs: 30, onError: logs, ...deps }, undefined, authorize);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  base = `ws://127.0.0.1:${address.port}`;
}

async function stop() {
  await live?.close();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  db = connectTestDb();
  store = new PgDraftStore({ db: db.db });
  const workspaceId = await insertWorkspace(db.db);
  const taskId = await insertTask(db.db, workspaceId);
  const draft = await store.openForTask(workspaceId, taskId, 'documents/shared.md');
  id = { workspaceId, taskId, draftFileId: draft.id, epoch: draft.epoch };
  git = {
    createDraft: vi.fn(async () => ({ branch: `human/${taskId}` })),
    readText: vi.fn(async () => ({ path: draft.path, text: 'shared base', hash: 'a'.repeat(40) })),
  };
  logs = vi.fn();
});

afterEach(async () => {
  for (const resolve of unblock.splice(0)) resolve();
  for (const peer of peers.splice(0)) { peer.provider.destroy(); peer.doc.destroy(); }
  for (const socket of sockets.splice(0)) socket.terminate();
  await stop();
  await db.close();
  if (root) { await rm(root, { recursive: true, force: true }); root = undefined; }
});

/** Presents the same session an ordinary request would; see capture.test.ts. */
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
  const peer = { doc, provider, acks, text: doc.getText(LIVE_TEXT_NAME) };
  peers.push(peer);
  provider.connect();
  return peer;
}

async function synced(...clients: ReturnType<typeof client>[]) {
  await vi.waitFor(() => { for (const c of clients) expect(c.provider.synced).toBe(true); }, { timeout: 10_000 });
}

async function storedText() {
  const loaded = await store.load(id.workspaceId, id.draftFileId);
  const doc = new Y.Doc();
  try {
    if (loaded?.yjsState) Y.applyUpdate(doc, loaded.yjsState);
    return { text: doc.getText(LIVE_TEXT_NAME).toString(), loaded };
  } finally { doc.destroy(); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  unblock.push(() => resolve());
  return { promise, resolve };
}

async function raw() {
  const ws = new WebSocket(base + liveRoomPath(id));
  ws.on('error', () => undefined);
  sockets.push(ws);
  await once(ws, 'open');
  return ws;
}

function updateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, LIVE_MESSAGE_SYNC);
  sync.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

async function rejectedUpgrade(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(base + path);
    ws.on('error', () => undefined);
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected upgrade')); });
    ws.on('unexpected-response', (_request, response) => {
      let result = '';
      response.on('data', (chunk) => { result += chunk.toString(); });
      response.on('end', () => { ws.terminate(); resolve(result); });
    });
  });
}

describe('D03 live documents', () => {
  it.each(['logout', 'membership removal', 'session expiry'])('rejects writes from an already-open socket after %s', async (change) => {
    const sessions = new SessionStore({ db: db.db, verify: vi.fn() });
    await listen({}, async ({ workspaceId, cookie }) => {
      const identity = await sessions.resolve(readSessionCookie(cookie));
      const access = await sessions.access(workspaceId, identity?.userId);
      if (!canWrite(access)) throw new ApiError(identity ? 'FORBIDDEN' : 'AUTH_REQUIRED', 'Access revoked.');
    });
    const peer = client();
    await synced(peer);
    peer.text.insert(peer.text.length, ' accepted');
    await vi.waitFor(async () => expect((await storedText()).text).toBe('shared base accepted'));
    if (change === 'logout') {
      await sessions.signOut(readSessionCookie(sessionCookie().cookie));
    } else if (change === 'session expiry') {
      await db.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) })
        .where('user_id', '=', TEST_USER_ID).execute();
    } else {
      await db.db.deleteFrom('workspace_members').where('workspace_id', '=', id.workspaceId)
        .where('user_id', '=', TEST_USER_ID).execute();
    }
    try {
      const closed = new Promise<{ code: number }>((resolve) => peer.provider.once('connection-close', resolve));
      peer.text.insert(peer.text.length, ' forbidden');
      expect((await closed).code).toBe(1008);
      expect((await storedText()).text).toBe('shared base accepted');
    } finally {
      if (change === 'session expiry') {
        await db.db.updateTable('sessions').set({ expires_at: new Date(Date.now() + 60 * 60 * 1000) })
          .where('user_id', '=', TEST_USER_ID).execute();
      }
    }
  });
  it('initializes simultaneous clients once from the real human Git branch', async () => {
    root = await mkdtemp(join(tmpdir(), 'd03-git-'));
    const real = new LocalGitService(root);
    await real.checkpoint({ workspaceId: id.workspaceId, taskId: id.taskId, files: [{ path: 'documents/shared.md', text: 'Git seed' }] });
    const read = vi.spyOn(real, 'readText');
    const initialize = vi.spyOn(store, 'initialize');
    await listen({ git: real });
    const a = client(); const b = client();
    await synced(a, b);
    expect(a.text.toString()).toBe('Git seed');
    expect(b.text.toString()).toBe('Git seed');
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    const loaded = await store.load(id.workspaceId, id.draftFileId);
    expect(loaded?.draftFile.baseBlobSha).toBe((await read.mock.results[0]!.value).hash);
    expect(loaded?.draftFile.persistedRevision).toBe(0);
  });

  it('adopts the winner of a database initialization race without merging seeds', async () => {
    const initialize = store.initialize.bind(store);
    vi.spyOn(store, 'initialize').mockImplementation(async (draftId, input) => {
      const winner = new Y.Doc();
      winner.getText(LIVE_TEXT_NAME).insert(0, 'winner');
      await initialize(draftId, { yjsState: Y.encodeStateAsUpdate(winner), stateVector: Y.encodeStateVector(winner), baseBlobSha: null });
      winner.destroy();
      return initialize(draftId, input);
    });
    await listen();
    const a = client(); const b = client(); await synced(a, b);
    expect(a.text.toString()).toBe('winner');
    expect(b.text.toString()).toBe('winner');
  });

  it('seeds absent files as empty text and retains existing persisted content', async () => {
    vi.mocked(git.readText).mockResolvedValue({ path: 'documents/shared.md', text: null, hash: null });
    await listen();
    const a = client(); await synced(a);
    expect(a.text.toString()).toBe('');
    expect((await storedText()).loaded?.draftFile.baseBlobSha).toBeNull();
    a.text.insert(0, 'saved');
    await vi.waitFor(async () => expect((await storedText()).text).toBe('saved'));
    a.provider.destroy();
    await stop();
    vi.mocked(git.readText).mockRejectedValue(new Error('Git must not be read'));
    await listen();
    const b = client(); await synced(b);
    expect(b.text.toString()).toBe('saved');
    expect(git.readText).toHaveBeenCalledTimes(1);
  });

  it('converges concurrent clients, isolates rooms, and removes disconnected awareness', async () => {
    await listen();
    const draft = await store.openForTask(id.workspaceId, id.taskId, 'documents/other.md');
    const a = client(); const b = client(); const other = client({ ...id, draftFileId: draft.id });
    await synced(a, b, other);
    a.text.insert(0, 'Alice '); b.text.insert(0, 'Bob ');
    a.provider.awareness.setLocalStateField('user', { name: 'Guest Cedar', color: '#123456' });
    await vi.waitFor(() => {
      expect(a.text.toString()).toBe(b.text.toString());
      expect(a.text.toString()).toContain('Alice');
      expect(a.text.toString()).toContain('Bob');
      expect(b.provider.awareness.getStates().get(a.doc.clientID)?.user.name).toBe('Guest Cedar');
    });
    expect(other.text.toString()).toBe('shared base');
    a.provider.disconnect();
    await vi.waitFor(() => expect(b.provider.awareness.getStates().has(a.doc.clientID)).toBe(false));
    await vi.waitFor(async () => expect((await storedText()).text).toBe(b.text.toString()));
  });

  it('coalesces persistence and acknowledges deletion-only and duplicate updates', async () => {
    const persist = vi.spyOn(store, 'persist');
    await listen({ debounceMs: 150 });
    const a = client(); await synced(a);
    a.text.insert(0, '1'); a.text.insert(0, '2'); a.text.delete(0, 2);
    await vi.waitFor(() => expect(a.acks.filter((ack) => ack.kind === LIVE_ACK_ACCEPTED).at(-1)?.revision).toBe(3));
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 3 }));
    expect(persist).toHaveBeenCalledTimes(1);
    expect((await storedText()).text).toBe('shared base');
    const vector = Y.encodeStateVector(a.doc);
    a.text.delete(0, 1);
    expect(Y.encodeStateVector(a.doc)).toEqual(vector);
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 4 }));
    expect((await storedText()).text).toBe('hared base');
    const count = a.acks.length;
    a.provider.ws!.send(updateMessage(Y.encodeStateAsUpdate(a.doc)));
    await vi.waitFor(() => expect(a.acks.length).toBeGreaterThan(count));
    expect(a.acks.at(-1)).toEqual({ kind: LIVE_ACK_PERSISTED, revision: 4 });
    expect(persist).toHaveBeenCalledTimes(2);
    const loaded = (await storedText()).loaded!;
    expect(loaded.stateVector).toEqual(Y.encodeStateVector(a.doc));
  });

  it('serializes saves and does not acknowledge later edits with an earlier save', async () => {
    const first = deferred(); const second = deferred();
    const persist = store.persist.bind(store);
    const calls: number[] = [];
    vi.spyOn(store, 'persist').mockImplementation(async (draft, input) => {
      calls.push(input.revision);
      await (calls.length === 1 ? first.promise : second.promise);
      return persist(draft, input);
    });
    await listen();
    const a = client(); await synced(a);
    a.text.insert(0, 'first');
    await vi.waitFor(() => expect(calls).toEqual([1]));
    a.text.insert(0, 'second');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_ACCEPTED, revision: 2 }));
    expect(calls).toEqual([1]);
    first.resolve();
    await vi.waitFor(() => {
      expect(calls).toEqual([1, 2]);
      expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 });
    });
    expect(a.acks).not.toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 2 });
    second.resolve();
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 2 }));
  });

  it('retains dirty state on failure, retries safely, and treats skipped saves as success', async () => {
    const persist = store.persist.bind(store);
    vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('private path and credentials'))
      .mockImplementation(async (draft, input) => {
        await persist(draft, input);
        return persist(draft, input); // The database guard returns applied: false.
      });
    await listen();
    const a = client(); await synced(a);
    a.text.insert(0, 'retry');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 }));
    expect(logs).toHaveBeenCalledWith({ draftFileId: id.draftFileId, code: 'DRAFT_NOT_SAVED' });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('credentials');
    expect((await storedText()).text).toBe('retryshared base');
    expect(store.persist).toHaveBeenCalledTimes(2);
  });

  it('holds an idle room through a failed save and reconnects without losing accepted edits', async () => {
    const persist = store.persist.bind(store);
    const load = vi.spyOn(store, 'load');
    const ready = deferred();
    vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('offline')).mockImplementation(async (draft, input) => {
      await ready.promise;
      return persist(draft, input);
    });
    await listen({ debounceMs: 500 });
    const a = client(); await synced(a);
    a.text.insert(0, 'retained');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_ACCEPTED, revision: 1 }));
    a.provider.disconnect();
    await vi.waitFor(() => expect(logs).toHaveBeenCalledTimes(1));
    const b = client(); await synced(b);
    expect(b.text.toString()).toBe('retainedshared base');
    expect(load).toHaveBeenCalledTimes(1);
    ready.resolve();
    await vi.waitFor(() => expect(b.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 }));
  });

  it('flushes on last disconnect, reloads on rejoin, and merges offline edits', async () => {
    const load = vi.spyOn(store, 'load');
    await listen({ debounceMs: 10_000 });
    const a = client(); await synced(a);
    a.text.insert(0, 'online');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_ACCEPTED, revision: 1 }));
    a.provider.disconnect();
    await vi.waitFor(async () => expect((await store.load(id.workspaceId, id.draftFileId))?.draftFile.persistedRevision).toBe(1));
    load.mockClear();
    a.text.insert(0, 'offline');
    const b = client(); await synced(b);
    expect(load).toHaveBeenCalledTimes(1);
    a.provider.connect(); await synced(a);
    await vi.waitFor(() => expect(b.text.toString()).toBe('offlineonlineshared base'));
    expect(git.readText).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid/scoped/closed upgrade requests before opening documents', async () => {
    const load = vi.spyOn(store, 'load');
    await listen();
    const cases: Array<[string, string]> = [
      ['/live/../arbitrary', 'VALIDATION_FAILED'],
      [liveRoomPath(id).replace(id.workspaceId, 'bad'), 'VALIDATION_FAILED'],
      [liveRoomPath(id).replace(/\/1$/, '/0'), 'VALIDATION_FAILED'],
      [liveRoomPath({ ...id, workspaceId: randomUUID() }), 'DRAFT_NOT_FOUND'],
      [liveRoomPath({ ...id, taskId: randomUUID() }), 'DRAFT_NOT_FOUND'],
      [liveRoomPath({ ...id, draftFileId: randomUUID() }), 'DRAFT_NOT_FOUND'],
      [liveRoomPath({ ...id, epoch: 2 }), 'DOCUMENT_EPOCH_CLOSED'],
    ];
    for (const [path, code] of cases) {
      const body = await rejectedUpgrade(path);
      expect(JSON.parse(body).error.code).toBe(code);
    }
    await store.closeEpoch(id.workspaceId, id.taskId);
    expect(JSON.parse(await rejectedUpgrade(liveRoomPath(id))).error.code).toBe('DOCUMENT_EPOCH_CLOSED');
    expect(load).not.toHaveBeenCalled();
    expect(git.createDraft).not.toHaveBeenCalled();
  });

  it('releases failed initialization and safely retries the same room', async () => {
    vi.mocked(git.readText).mockRejectedValueOnce(new Error('private filesystem path'));
    await listen();
    const body = await rejectedUpgrade(liveRoomPath(id));
    expect(JSON.parse(body).error.code).toBe('INTERNAL_ERROR');
    expect(body).not.toContain('filesystem');
    const a = client(); await synced(a);
    expect(a.text.toString()).toBe('shared base');
    expect(git.readText).toHaveBeenCalledTimes(2);
  });

  it('rejects closure during initialization before attaching any client', async () => {
    const initialize = store.initialize.bind(store);
    vi.spyOn(store, 'initialize').mockImplementation(async (draft, input) => {
      await store.closeEpoch(id.workspaceId, id.taskId);
      return initialize(draft, input);
    });
    await listen();
    const body = await rejectedUpgrade(liveRoomPath(id));
    expect(JSON.parse(body).error.code).toBe('DOCUMENT_EPOCH_CLOSED');
    expect((await store.load(id.workspaceId, id.draftFileId))?.yjsState).toBeNull();
  });

  it('preserves pending Yjs dependencies across persistence and restart', async () => {
    await listen();
    const a = client(); await synced(a);
    const remote = new Y.Doc();
    const updates: Uint8Array[] = [];
    remote.on('update', (update: Uint8Array) => updates.push(update));
    remote.getText(LIVE_TEXT_NAME).insert(0, 'first');
    remote.getText(LIVE_TEXT_NAME).insert(5, 'second');
    // The second insert depends on the first. Persisting only visible text or
    // listening only for integrated updates would drop this pending content.
    a.provider.ws!.send(updateMessage(updates[1]!));
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 }));
    a.provider.shouldConnect = false;
    await stop();
    await listen();
    const b = client(); await synced(b);
    b.provider.ws!.send(updateMessage(updates[0]!));
    await vi.waitFor(() => expect(b.text.toString()).toContain('firstsecond'));
    await vi.waitFor(() => expect(b.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 2 }));
    remote.destroy();
  });

  it.each(['extra type', 'NUL', 'too much text'])('rejects %s without partial document mutation', async (kind) => {
    await listen();
    const a = client(); await synced(a);
    const ws = await raw();
    const invalid = new Y.Doc();
    if (kind === 'extra type') invalid.getMap('metadata').set('path', '../escape');
    else invalid.getText(LIVE_TEXT_NAME).insert(0, kind === 'NUL' ? '\0' : 'x'.repeat(1024 * 1024 + 1));
    const closed = once(ws, 'close');
    ws.send(updateMessage(Y.encodeStateAsUpdate(invalid)));
    expect((await closed)[0]).toBe(1008);
    invalid.destroy();
    expect(a.text.toString()).toBe('shared base');
    a.text.insert(0, 'valid');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 }));
  });

  it('closes a cached room when persistence discovers epoch closure without acknowledging the edit', async () => {
    await listen();
    const a = client(); await synced(a);
    await store.closeEpoch(id.workspaceId, id.taskId);
    const closed = new Promise<number>((resolve) => a.provider.on('connection-close', (event: { code: number } | null) => { if (event) resolve(event.code); }));
    a.text.insert(0, 'late');
    expect(await closed).toBe(4409);
    expect(a.acks).not.toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 });
    expect((await storedText()).text).toBe('shared base');
    expect(a.text.toString()).toBe('lateshared base');
  });

  it.each([
    ['text', 'not binary'], ['unknown', new Uint8Array([99])],
    ['truncated', new Uint8Array([0, 2, 20, 0])],
    ['bad Yjs', new Uint8Array([0, 2, 1, 255])],
    ['oversized', new Uint8Array(MAX_LIVE_MESSAGE_BYTES + 1)],
  ])('rejects %s messages without disturbing other clients', async (_label, message) => {
    await listen();
    const a = client(); await synced(a);
    const ws = await raw();
    const closed = once(ws, 'close');
    ws.send(message);
    const [code] = await closed;
    expect([1008, 1009]).toContain(code);
    a.text.insert(0, 'valid');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 }));
  });

  it('flushes at shutdown and restores the acknowledged revision after restart', async () => {
    await listen({ debounceMs: 10_000 });
    const a = client(); await synced(a);
    a.text.insert(0, 'shutdown');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_ACCEPTED, revision: 1 }));
    a.provider.shouldConnect = false;
    await stop();
    expect((await storedText()).text).toBe('shutdownshared base');
    await listen();
    const b = client(); await synced(b);
    expect(b.text.toString()).toBe('shutdownshared base');
    expect(b.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 1 });
    b.text.insert(0, 'next');
    await vi.waitFor(() => expect(b.acks).toContainEqual({ kind: LIVE_ACK_PERSISTED, revision: 2 }));
  });

  it('reports shutdown durability failure while still closing the listener', async () => {
    vi.spyOn(store, 'persist').mockRejectedValue(new Error('database unavailable'));
    await listen({ debounceMs: 10_000 });
    const a = client(); await synced(a);
    a.text.insert(0, 'unsaved');
    await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_ACCEPTED, revision: 1 }));
    a.provider.shouldConnect = false;
    await expect(live.close()).rejects.toMatchObject({ code: 'DRAFT_NOT_SAVED' });
    // Preserve the expected failure assertion above without repeating it in cleanup.
    live = { close: async () => undefined };
    await stop();
    expect(server.listening).toBe(false);
  });

  it('uses the default runtime attachment and closes sockets before database cleanup', async () => {
    root = await mkdtemp(join(tmpdir(), 'd03-runtime-'));
    const runtimeDb = connectTestDb();
    const closeDb = vi.spyOn(runtimeDb, 'close');
    const runtime = await startRuntime({
      config: testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl() }),
      createDatabase: () => runtimeDb, listen: { host: '127.0.0.1', port: 0 },
    });
    await authenticateRuntime(runtime.app, db.db);
    try {
      const address = runtime.app.server.address() as { port: number };
      base = `ws://127.0.0.1:${address.port}`;
      const a = client(); await synced(a);
      expect(a.text.toString()).toBe('');
      a.text.insert(0, 'runtime');
      await vi.waitFor(() => expect(a.acks).toContainEqual({ kind: LIVE_ACK_ACCEPTED, revision: 1 }));
      a.provider.shouldConnect = false;
      await runtime.close();
      expect(closeDb).toHaveBeenCalledTimes(1);
      expect((await storedText()).text).toBe('runtime');
    } finally { await runtime.close(); }
  });
});
