import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import * as Y from 'yjs';
import { WebSocketServer } from 'ws';
import { ApiError, LIVE_TEXT_NAME, liveRoomPath, liveRoomSchema, type GitService, type LiveRoomId } from '@app/contracts';
import type { PgDraftStore } from '../drafts/store.js';
import { LiveRoom, MAX_LIVE_MESSAGE_BYTES } from './room.js';

export interface LiveDocumentDeps {
  drafts: Pick<PgDraftStore, 'resolveRoom' | 'load' | 'initialize' | 'persist'>;
  git: Pick<GitService, 'createDraft' | 'readText'>;
  /** Receives only safe identifiers and error codes, never raw errors/content. */
  onError?: (fields: { draftFileId: string; code: 'DRAFT_NOT_SAVED' }) => void;
  debounceMs?: number;
}

interface Entry {
  ready: Promise<LiveRoom>;
  room?: LiveRoom;
  /** Includes pending joins, preventing eviction between load and attachment. */
  users: number;
}

function parseRoom(url: string | undefined): LiveRoomId {
  // Parse the raw pathname, not URL-normalized dot segments or decoded paths.
  const parts = (url ?? '').split('?')[0]!.split('/');
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'live' || !/^[1-9]\d*$/.test(parts[5]!)) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid document room.');
  }
  const parsed = liveRoomSchema.safeParse({
    workspaceId: parts[2], taskId: parts[3], draftFileId: parts[4], epoch: Number(parts[5]),
  });
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Invalid document room.');
  return parsed.data;
}

function reject(socket: Duplex, error: unknown): void {
  if (socket.destroyed) return;
  const safe = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', 'Could not open the shared draft.');
  const body = JSON.stringify(safe.toBody());
  socket.end(`HTTP/1.1 ${safe.httpStatus} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** One registry and upgrade listener per runtime; no global Yjs server state. */
export function attachLiveDocuments(server: Server, deps: LiveDocumentDeps): { close(): Promise<void> } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LIVE_MESSAGE_BYTES, perMessageDeflate: false });
  const entries = new Map<string, Entry>();
  const pending = new Set<Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;

  function evict(key: string, entry: Entry): void {
    const room = entry.room;
    if (stopping || entry.users !== 0 || !room || room.busy || (room.dirty && !room.closed)) return;
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    room.destroy();
  }

  async function initialize(id: LiveRoomId, key: string, entry: Entry): Promise<LiveRoom> {
    let loaded = await deps.drafts.load(id.workspaceId, id.draftFileId);
    if (!loaded) throw new ApiError('DRAFT_NOT_FOUND');
    if (loaded.draftFile.status !== 'active' || loaded.draftFile.epoch !== id.epoch) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
    const doc = new Y.Doc();
    doc.getText(LIVE_TEXT_NAME);
    try {
      if (loaded.yjsState === null) {
        await deps.git.createDraft({ workspaceId: id.workspaceId, taskId: id.taskId });
        const source = await deps.git.readText({
          workspaceId: id.workspaceId, target: { kind: 'draft', taskId: id.taskId },
          path: loaded.draftFile.path, allowedPaths: [loaded.draftFile.path],
        });
        const seed = new Y.Doc();
        try {
          seed.getText(LIVE_TEXT_NAME).insert(0, source.text ?? '');
          loaded = (await deps.drafts.initialize(id.draftFileId, {
            yjsState: Y.encodeStateAsUpdate(seed), stateVector: Y.encodeStateVector(seed), baseBlobSha: source.hash,
          })).draft;
        } finally { seed.destroy(); }
      }
      if (loaded.yjsState === null) throw new ApiError('DRAFT_NOT_SAVED');
      // Always adopt the returned state, including when another initializer won.
      Y.applyUpdate(doc, loaded.yjsState);
      const room = new LiveRoom({
        draftFileId: id.draftFileId, doc, revision: loaded.draftFile.persistedRevision,
        store: deps.drafts, debounceMs: deps.debounceMs,
        onError: () => deps.onError?.({ draftFileId: id.draftFileId, code: 'DRAFT_NOT_SAVED' }),
        onIdle: () => evict(key, entry),
      });
      entry.room = room;
      return room;
    } catch (error) { doc.destroy(); throw error; }
  }

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let release: (() => void) | undefined;
    try {
      if (stopping) { socket.destroy(); return; }
      const id = parseRoom(request.url);
      const draft = await deps.drafts.resolveRoom(id);
      if (draft.epoch !== id.epoch) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
      if (stopping || socket.destroyed) { socket.destroy(); return; }
      const key = liveRoomPath(id);
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry = {
          users: 0,
          ready: Promise.resolve().then(() => initialize(id, key, created)).catch((error: unknown) => {
            if (entries.get(key) === created) entries.delete(key);
            throw error;
          }),
        };
        entries.set(key, created);
        entry = created;
      }
      const reserved = entry;
      reserved.users++;
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        reserved.users--;
        if (reserved.users === 0 && reserved.room && !stopping) {
          void reserved.room.flush().catch(() => undefined);
        }
      };
      const room = await reserved.ready;
      // Recheck after asynchronous initialization, including cached room joins.
      const current = await deps.drafts.resolveRoom(id);
      if (current.epoch !== id.epoch || room.closed) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
      if (stopping || socket.destroyed) { socket.destroy(); return; }
      const detach = release;
      wss.handleUpgrade(request, socket, head, (ws) => {
        room.attach(ws, detach);
        release = undefined;
      });
    } catch (error) { reject(socket, error); }
    finally { release?.(); }
  }

  const listener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Raw upgrade sockets do not inherit Fastify's error handler.
    socket.on('error', () => socket.destroy());
    const operation = upgrade(request, socket, head);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  server.on('upgrade', listener);

  return {
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      for (const entry of entries.values()) entry.room?.stop();
      closing = (async () => {
        // Leave listener installed until pending joins settle so new upgrades
        // are rejected during shutdown instead of hanging on the HTTP server.
        await Promise.allSettled([...pending]);
        const rooms = [...entries.values()].flatMap((entry) => entry.room ? [entry.room] : []);
        for (const room of rooms) room.stop();
        const saved = await Promise.allSettled(rooms.map((room) => room.flush()));
        for (const room of rooms) room.destroy();
        entries.clear();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        server.off('upgrade', listener);
        if (saved.some((result) => result.status === 'rejected')) throw new ApiError('DRAFT_NOT_SAVED');
      })();
      return closing;
    },
  };
}
