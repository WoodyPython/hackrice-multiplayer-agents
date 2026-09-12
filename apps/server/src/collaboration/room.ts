import * as Y from 'yjs';
import * as awareness from 'y-protocols/awareness';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import {
  ApiError, LIVE_ACK_ACCEPTED, LIVE_ACK_PERSISTED, LIVE_EPOCH_CLOSED_CODE,
  LIVE_MESSAGE_ACK, LIVE_MESSAGE_AWARENESS, LIVE_MESSAGE_QUERY_AWARENESS,
  LIVE_MESSAGE_SYNC, LIVE_TEXT_NAME,
} from '@app/contracts';
import type { PgDraftStore } from '../drafts/store.js';

/** Binary history can exceed the 1 MiB text limit; bound transport separately. */
export const MAX_LIVE_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

export interface RoomOptions {
  draftFileId: string;
  doc: Y.Doc;
  revision: number;
  store: Pick<PgDraftStore, 'persist'>;
  onIdle: () => void;
  onError: () => void;
  debounceMs?: number;
  processUpdate?: (operation: () => void) => Promise<void>;
}

/** Owns document mutations and ordered saves. No Git writes or capture logic. */
export class LiveRoom {
  readonly doc: Y.Doc;
  readonly awareness: awareness.Awareness;
  readonly connections = new Map<WebSocket, Set<number>>();
  revision: number;
  persistedRevision: number;
  closed = false;
  private stopping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private queuedBytes = 0;
  private queuedUpdates = 0;
  private readonly heartbeats = new Map<WebSocket, ReturnType<typeof setInterval>>();

  constructor(private readonly options: RoomOptions) {
    this.doc = options.doc;
    this.revision = this.persistedRevision = options.revision;
    this.awareness = new awareness.Awareness(this.doc);
    this.awareness.setLocalState(null);
    this.awareness.on('update', ({ added, updated, removed }: {
      added: number[]; updated: number[]; removed: number[];
    }, origin: unknown) => {
      const controlled = this.connections.get(origin as WebSocket);
      for (const id of added) controlled?.add(id);
      for (const id of removed) controlled?.delete(id);
      this.broadcast(this.awarenessMessage([...added, ...updated, ...removed]));
    });
  }

  get dirty(): boolean { return this.revision > this.persistedRevision; }
  get busy(): boolean { return this.saving !== undefined || this.queuedUpdates > 0; }

  attach(socket: WebSocket, release: () => void): void {
    this.connections.set(socket, new Set());
    let alive = true;
    const interval = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
    interval.unref();
    this.heartbeats.set(socket, interval);
    socket.on('pong', () => { alive = true; });
    // ws already starts a protocol close (e.g. 1009) on receiver errors.
    // Preserve that close frame rather than replacing it with an abrupt reset.
    socket.on('error', () => { if (socket.readyState === WebSocket.OPEN) socket.terminate(); });
    socket.once('close', () => {
      clearInterval(interval);
      this.heartbeats.delete(socket);
      const ids = this.connections.get(socket);
      this.connections.delete(socket);
      if (ids) awareness.removeAwarenessStates(this.awareness, [...ids], null);
      release();
    });
    socket.on('message', (data, binary) => {
      if (this.stopping || this.closed) return;
      try {
        if (!binary) throw new Error('Expected binary message');
        const bytes = Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data as ArrayBuffer);
        this.receive(socket, bytes);
      } catch {
        socket.close(1008, 'VALIDATION_FAILED');
      }
    });
    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, LIVE_MESSAGE_SYNC);
    sync.writeSyncStep1(hello, this.doc);
    this.send(socket, encoding.toUint8Array(hello));
    this.send(socket, this.awarenessMessage([...this.awareness.getStates().keys()]));
    this.ack(socket, LIVE_ACK_PERSISTED, this.persistedRevision);
  }

  private receive(socket: WebSocket, bytes: Uint8Array): void {
    if (bytes.byteLength > MAX_LIVE_MESSAGE_BYTES) throw new Error('Message too large');
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === LIVE_MESSAGE_QUERY_AWARENESS) {
      this.end(decoder);
      this.send(socket, this.awarenessMessage([...this.awareness.getStates().keys()]));
    } else if (type === LIVE_MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      this.end(decoder);
      // Decode completely first: a truncated entry must not partially mutate presence.
      const check = decoding.createDecoder(update);
      const count = decoding.readVarUint(check);
      for (let i = 0; i < count; i++) {
        decoding.readVarUint(check);
        decoding.readVarUint(check);
        const state: unknown = JSON.parse(decoding.readVarString(check));
        if (state !== null && (typeof state !== 'object' || Array.isArray(state))) throw new Error('Invalid awareness');
      }
      this.end(check);
      awareness.applyAwarenessUpdate(this.awareness, update, socket);
    } else if (type === LIVE_MESSAGE_SYNC) {
      const subtype = decoding.readVarUint(decoder);
      const payload = decoding.readVarUint8Array(decoder);
      this.end(decoder);
      if (subtype === sync.messageYjsSyncStep1) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, LIVE_MESSAGE_SYNC);
        sync.writeSyncStep2(reply, this.doc, payload);
        this.send(socket, encoding.toUint8Array(reply));
      } else if (subtype === sync.messageYjsSyncStep2 || subtype === sync.messageYjsUpdate) {
        if (!this.options.processUpdate) { this.accept(socket, payload); return; }
        if (this.queuedBytes + bytes.byteLength > MAX_LIVE_MESSAGE_BYTES) {
          socket.close(1009, 'Queued updates too large');
          return;
        }
        this.queuedBytes += bytes.byteLength;
        this.queuedUpdates++;
        // Queue at receipt, before any await, so a capture cannot overtake it.
        void this.options.processUpdate(() => {
          if (!this.closed) this.accept(socket, payload);
        }).catch(() => socket.close(1008, 'VALIDATION_FAILED')).finally(() => {
          this.queuedBytes -= bytes.byteLength;
          this.queuedUpdates--;
          this.options.onIdle();
        });
      } else throw new Error('Unknown sync message');
    } else throw new Error('Unknown message');
  }

  private end(decoder: decoding.Decoder): void {
    if (decoding.hasContent(decoder)) throw new Error('Trailing bytes');
  }

  private accept(socket: WebSocket, update: Uint8Array): void {
    // Validate on a disposable copy: Yjs transactions do not roll back malformed
    // updates. Include pending structs/deletes in comparison, not only the text
    // or state vector (deletion-only updates need durable acknowledgement too).
    const before = Y.encodeStateAsUpdate(this.doc);
    const candidate = new Y.Doc();
    let changed: boolean;
    try {
      candidate.getText(LIVE_TEXT_NAME);
      Y.applyUpdate(candidate, before);
      Y.applyUpdate(candidate, update);
      if ([...candidate.share.keys()].some((key) => key !== LIVE_TEXT_NAME)) throw new Error('Unknown shared type');
      const text = candidate.getText(LIVE_TEXT_NAME).toString();
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES || text.includes('\0')) throw new Error('Invalid text');
      const after = Y.encodeStateAsUpdate(candidate);
      if (after.byteLength > MAX_LIVE_MESSAGE_BYTES) throw new Error('Document history too large');
      changed = !Buffer.from(before).equals(Buffer.from(after));
    } finally { candidate.destroy(); }
    if (changed) {
      if (!Number.isSafeInteger(this.revision + 1)) throw new Error('Revision exhausted');
      Y.applyUpdate(this.doc, update, socket);
      this.revision++;
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, LIVE_MESSAGE_SYNC);
      sync.writeUpdate(message, update);
      this.broadcast(encoding.toUint8Array(message));
      this.schedule();
    }
    // Also acknowledge retransmissions; they may already be durably covered.
    this.ack(socket, LIVE_ACK_ACCEPTED, this.revision);
    if (!this.dirty) this.ack(socket, LIVE_ACK_PERSISTED, this.persistedRevision);
  }

  private awarenessMessage(ids: number[]): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, LIVE_MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awareness.encodeAwarenessUpdate(this.awareness, ids));
    return encoding.toUint8Array(encoder);
  }

  private ack(socket: WebSocket, kind: number, revision: number): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, LIVE_MESSAGE_ACK);
    encoding.writeVarUint(encoder, kind);
    encoding.writeVarUint(encoder, revision);
    this.send(socket, encoding.toUint8Array(encoder));
  }

  private send(socket: WebSocket, bytes: Uint8Array): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_LIVE_MESSAGE_BYTES) { socket.terminate(); return; }
    socket.send(bytes, (error) => { if (error) socket.terminate(); });
  }

  private broadcast(bytes: Uint8Array): void {
    for (const socket of this.connections.keys()) this.send(socket, bytes);
  }

  private schedule(): void {
    if (this.timer || this.stopping || this.closed) return;
    // A bounded coalescing window also saves during continuous typing.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.options.debounceMs ?? 500);
    this.timer.unref();
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.dirty && !this.closed) {
        const revision = this.revision;
        const result = await this.options.store.persist(this.options.draftFileId, {
          revision,
          yjsState: Y.encodeStateAsUpdate(this.doc),
          stateVector: Y.encodeStateVector(this.doc),
        });
        this.persistedRevision = Math.max(this.persistedRevision, result.persistedRevision);
        for (const socket of this.connections.keys()) this.ack(socket, LIVE_ACK_PERSISTED, this.persistedRevision);
      }
    })().catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'DOCUMENT_EPOCH_CLOSED') {
        this.closed = true;
        for (const socket of this.connections.keys()) socket.close(LIVE_EPOCH_CLOSED_CODE, 'DOCUMENT_EPOCH_CLOSED');
      } else {
        this.options.onError();
        this.schedule();
        throw new ApiError('DRAFT_NOT_SAVED', 'The shared draft could not be saved.');
      }
    }).finally(() => {
      this.saving = undefined;
      this.options.onIdle();
    });
    return this.saving;
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const socket of this.connections.keys()) socket.terminate();
  }

  destroy(): void {
    this.stop();
    for (const interval of this.heartbeats.values()) clearInterval(interval);
    this.heartbeats.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
