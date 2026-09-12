import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awareness from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { LIVE_MESSAGE_SYNC, LIVE_MESSAGE_AWARENESS, LIVE_MESSAGE_ACK,
  LIVE_ACK_ACCEPTED, LIVE_ACK_PERSISTED, LIVE_EPOCH_CLOSED_CODE,
  liveRoomPath, type LiveRoomId } from '@app/contracts';

export type SaveState = 'connecting' | 'saving' | 'saved' | 'offline' | 'closed' | 'rejected';

/** Uses the D03 sync/awareness protocol; accepted writes are not durable saves. */
export class LiveDocument {
  readonly doc = new Y.Doc();
  readonly awareness = new awareness.Awareness(this.doc);
  state: SaveState = 'connecting';
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private synced = false;
  private pending = 0;
  private accepted = -1;
  private persisted = -1;
  private attempts = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  constructor(room: LiveRoomId, private socketFactory = (url: string) => new WebSocket(url),
    origin = window.location.origin) {
    const url = new URL(liveRoomPath(room), origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.doc.on('update', (update: Uint8Array, source: unknown) => {
      if (source === this) {
        // Each new server update consumes one room revision. Echoes of our own
        // updates are Yjs no-ops and never enter this listener a second time.
        if (this.synced) this.accepted = Math.max(this.accepted, this.persisted) + 1;
        return;
      }
      this.sendSync((encoder) => sync.writeUpdate(encoder, update), true);
      this.refresh();
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, source: unknown) => {
      if (source !== this) this.sendAwareness([...added, ...updated, ...removed]);
    });
    this.connect(url.href);
  }
  private set(state: SaveState) { this.state = state; this.listeners.forEach((listener) => listener()); }
  private refresh() {
    if (this.stopped) return;
    if (this.socket?.readyState !== 1) { this.set('offline'); return; }
    this.set(!this.synced ? 'connecting' : this.pending > 0 || this.accepted < 0 || this.persisted < this.accepted ? 'saving' : 'saved');
  }
  private sendSync(write: (encoder: encoding.Encoder) => void, acknowledge = false) {
    if (this.socket?.readyState !== 1) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, LIVE_MESSAGE_SYNC);
    write(encoder);
    if (acknowledge) this.pending++;
    this.socket.send(encoding.toUint8Array(encoder));
  }
  private sendAwareness(ids: number[]) {
    if (this.socket?.readyState !== 1) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, LIVE_MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awareness.encodeAwarenessUpdate(this.awareness, ids));
    this.socket.send(encoding.toUint8Array(encoder));
  }
  private connect(url: string) {
    if (this.stopped) return;
    const socket = this.socket = this.socketFactory(url);
    socket.binaryType = 'arraybuffer';
    this.synced = false;
    this.pending = 0;
    this.accepted = this.persisted = -1;
    socket.onopen = () => {
      this.sendSync((encoder) => sync.writeSyncStep1(encoder, this.doc));
      this.sendAwareness([this.doc.clientID]);
      this.refresh();
    };
    socket.onmessage = (event) => {
      if (this.stopped) return;
      try {
        const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
        const type = decoding.readVarUint(decoder);
        if (type === LIVE_MESSAGE_SYNC) {
          const subtype = decoding.readVarUint(decoder);
          if (subtype === sync.messageYjsSyncStep1) {
            const vector = decoding.readVarUint8Array(decoder);
            this.sendSync((encoder) => sync.writeSyncStep2(encoder, this.doc, vector), true);
          } else if (subtype === sync.messageYjsSyncStep2 || subtype === sync.messageYjsUpdate) {
            Y.applyUpdate(this.doc, decoding.readVarUint8Array(decoder), this);
            if (subtype === sync.messageYjsSyncStep2) { this.synced = true; this.attempts = 0; }
          } else throw new Error('Invalid sync message');
        } else if (type === LIVE_MESSAGE_AWARENESS) {
          awareness.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        } else if (type === LIVE_MESSAGE_ACK) {
          const kind = decoding.readVarUint(decoder);
          const revision = decoding.readVarUint(decoder);
          if (kind === LIVE_ACK_ACCEPTED) {
            this.pending = Math.max(0, this.pending - 1);
            this.accepted = Math.max(this.accepted, revision);
          } else if (kind === LIVE_ACK_PERSISTED) this.persisted = Math.max(this.persisted, revision);
          else throw new Error('Invalid acknowledgement');
        } else throw new Error('Invalid message');
        this.refresh();
      } catch { this.stopped = true; this.set('rejected'); socket.close(); }
    };
    socket.onerror = () => { /* close handles retries; retain the local document */ };
    socket.onclose = (event) => {
      awareness.removeAwarenessStates(this.awareness,
        [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID), this);
      if (this.stopped) return;
      if ([LIVE_EPOCH_CLOSED_CODE, 1008, 1009].includes(event.code)) {
        this.stopped = true;
        this.set(event.code === LIVE_EPOCH_CLOSED_CODE ? 'closed' : 'rejected');
        return;
      }
      this.set('offline');
      this.timer = setTimeout(() => this.connect(url), Math.min(1000 * 2 ** this.attempts++, 10000));
    };
  }
  destroy() {
    this.awareness.setLocalState(null);
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.close();
    }
    this.awareness.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }
}
