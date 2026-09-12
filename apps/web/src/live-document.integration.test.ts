// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { expect, it } from 'vitest';
import { LiveRoom } from '../../server/src/collaboration/room';
import { LiveDocument } from './live-document';

it('two WebSocket clients edit, share cursor identity, reconnect, and await durable saves against D03', async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let saved = new Uint8Array();
  const document = new Y.Doc(); document.getText('content').insert(0, '# Shared\n');
  const room = new LiveRoom({ draftFileId: 'draft', doc: document, revision: 0,
    store: { persist: async (_id, snapshot) => { saved = new Uint8Array(snapshot.yjsState); return { applied: true, persistedRevision: snapshot.revision }; } },
    onIdle: () => {}, onError: () => {}, debounceMs: 20 });
  sockets.on('connection', (socket) => room.attach(socket, () => {}));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const id = { workspaceId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002', draftFileId: '00000000-0000-4000-8000-000000000003', epoch: 1 };
  const peer = () => new LiveDocument(id, (url) => new WebSocket(url) as unknown as globalThis.WebSocket, `http://127.0.0.1:${address.port}`);
  const a = peer(); const b = peer();
  try {
    await expect.poll(() => [a.state, b.state]).toEqual(['saved', 'saved']);
    a.awareness.setLocalStateField('user', { name: 'Guest Cedar', color: '#286548' });
    a.awareness.setLocalStateField('selection', { anchor: Y.createRelativePositionFromTypeIndex(a.doc.getText('content'), 0), head: Y.createRelativePositionFromTypeIndex(a.doc.getText('content'), 2) });
    await expect.poll(() => b.awareness.getStates().get(a.doc.clientID)?.user.name).toBe('Guest Cedar');
    a.doc.getText('content').insert(9, 'A'); b.doc.getText('content').insert(9, 'B');
    await expect.poll(() => a.doc.getText('content').toString() === b.doc.getText('content').toString()).toBe(true);
    await expect.poll(() => [a.state, b.state]).toEqual(['saved', 'saved']);
    const restored = new Y.Doc(); Y.applyUpdate(restored, saved);
    expect(restored.getText('content').toString()).toBe(a.doc.getText('content').toString()); restored.destroy();
    for (const socket of room.connections.keys()) socket.terminate();
    await expect.poll(() => a.state).toBe('offline');
    a.doc.getText('content').insert(0, 'Offline edit\n');
    await expect.poll(() => [a.state, b.state], { timeout: 5000 }).toEqual(['saved', 'saved']);
    expect(b.doc.getText('content').toString()).toBe(a.doc.getText('content').toString());
  } finally {
    a.destroy(); b.destroy(); room.destroy();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);
