import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { LiveDocument } from './live-document';

const room = { workspaceId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002', draftFileId: '00000000-0000-4000-8000-000000000003', epoch: 1 };
const clients: LiveDocument[] = [];
afterEach(() => { clients.forEach((client) => client.destroy()); clients.length = 0; vi.useRealTimers(); });

class Socket {
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror = null;
  sent: Uint8Array[] = [];
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(write: (encoder: encoding.Encoder) => void) {
    const encoder = encoding.createEncoder(); write(encoder);
    this.onmessage?.({ data: encoding.toUint8Array(encoder).slice().buffer });
  }
  ack(kind: number, revision: number) { this.receive((encoder) => [4, kind, revision].forEach((n) => encoding.writeVarUint(encoder, n))); }
  hello(doc: Y.Doc) {
    this.receive((encoder) => { encoding.writeVarUint(encoder, 0); sync.writeSyncStep1(encoder, doc); });
    this.receive((encoder) => { encoding.writeVarUint(encoder, 0); sync.writeSyncStep2(encoder, doc); });
  }
}
function client() {
  const sockets: Socket[] = [];
  const live = new LiveDocument(room, () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; }, 'https://example.test');
  clients.push(live);
  return { live, sockets };
}

it('does not label initial sync, accepted-only writes, or a later in-flight edit as saved', () => {
  const { live, sockets } = client(); const socket = sockets[0]!;
  const server = new Y.Doc(); server.getText('content').insert(0, 'Hello');
  socket.open(); socket.ack(1, 0); socket.hello(server);
  expect(live.state).toBe('saving');
  socket.ack(0, 0); expect(live.state).toBe('saved');
  live.doc.getText('content').insert(5, ' world');
  socket.ack(0, 1); expect(live.state).toBe('saving');
  live.doc.getText('content').delete(0, 1);
  socket.ack(1, 1); expect(live.state).toBe('saving');
  socket.ack(0, 2); socket.ack(1, 2); expect(live.state).toBe('saved');
  const remote = new Y.Doc();
  remote.getText('content').insert(0, 'Remote');
  socket.receive((encoder) => { encoding.writeVarUint(encoder, 0); sync.writeUpdate(encoder, Y.encodeStateAsUpdate(remote)); });
  expect(live.state).toBe('saving');
  socket.ack(1, 3); expect(live.state).toBe('saved');
  remote.destroy();
  server.destroy();
});

it('converges concurrent edits from two clients through server sync messages', () => {
  const a = client(); const b = client(); const server = new Y.Doc();
  for (const c of [a, b]) { c.sockets[0]!.open(); c.sockets[0]!.hello(server); }
  a.live.doc.getText('content').insert(0, 'Cedar');
  b.live.doc.getText('content').insert(0, 'Maple');
  for (const c of [a, b]) {
    for (const bytes of c.sockets[0]!.sent) {
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) !== 0) continue;
      const subtype = decoding.readVarUint(decoder);
      if (subtype !== sync.messageYjsSyncStep1) Y.applyUpdate(server, decoding.readVarUint8Array(decoder));
    }
  }
  for (const c of [a, b]) c.sockets[0]!.hello(server);
  expect(a.live.doc.getText('content').toString()).toBe(b.live.doc.getText('content').toString());
  expect(a.live.doc.getText('content').toString()).toContain('Cedar');
  expect(a.live.doc.getText('content').toString()).toContain('Maple');
  server.destroy();
});

it('retains offline edits on reconnect and stops retrying a closed epoch', () => {
  vi.useFakeTimers();
  const { live, sockets } = client(); const server = new Y.Doc();
  sockets[0]!.open(); sockets[0]!.hello(server); sockets[0]!.close();
  live.doc.getText('content').insert(0, 'Keep me');
  expect(live.state).toBe('offline');
  vi.advanceTimersByTime(1000);
  sockets[1]!.open(); sockets[1]!.hello(server);
  expect(live.doc.getText('content').toString()).toBe('Keep me');
  expect(live.state).toBe('saving');
  sockets[1]!.close(4409); expect(live.state).toBe('closed');
  vi.advanceTimersByTime(30000); expect(sockets).toHaveLength(2);
  expect(live.doc.getText('content').toString()).toBe('Keep me');
  server.destroy();
});
