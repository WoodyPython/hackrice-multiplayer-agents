import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { ApiError, liveRoomSchema, type LiveRoomId } from '@app/contracts';
import { LiveDocumentCoordinator, type LiveDocumentDeps } from './coordinator.js';
import { MAX_LIVE_MESSAGE_BYTES } from './room.js';

export type { LiveDocumentDeps } from './coordinator.js';

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

/** One upgrade listener and coordinator per runtime; no global Yjs state. */
export function attachLiveDocuments(server: Server, deps: LiveDocumentDeps,
  coordinator = new LiveDocumentCoordinator(deps)): { close(): Promise<void> } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LIVE_MESSAGE_BYTES, perMessageDeflate: false });
  const pending = new Set<Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let release: (() => void) | undefined;
    try {
      if (stopping) { socket.destroy(); return; }
      const acquired = await coordinator.acquire(parseRoom(request.url));
      release = acquired.release;
      if (stopping || socket.destroyed) { socket.destroy(); return; }
      const detach = release;
      wss.handleUpgrade(request, socket, head, (ws) => {
        acquired.room.attach(ws, detach);
        release = undefined;
      });
    } catch (error) { reject(socket, error); }
    finally { release?.(); }
  }

  const listener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    const operation = upgrade(request, socket, head);
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  };
  server.on('upgrade', listener);

  return {
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      // Start draining capture and updates immediately, before waiting for joins.
      const draining = coordinator.close();
      closing = (async () => {
        const [saved] = await Promise.allSettled([draining, Promise.allSettled([...pending])]);
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        server.off('upgrade', listener);
        if (saved.status === 'rejected') throw saved.reason;
      })();
      return closing;
    },
  };
}
