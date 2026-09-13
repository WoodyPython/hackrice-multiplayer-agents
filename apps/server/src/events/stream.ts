import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { uuidSchema, type RefreshHint } from '@app/contracts';
import type { Broadcaster } from './broadcaster.js';
import { parseOrThrow } from '../http/errors.js';
import { z } from 'zod';

/** Same-origin, workspace-scoped hints. No message bodies or credentials. */
export class RefreshStream implements Broadcaster {
  private rooms = new Map<string, Set<ServerResponse>>();

  attach(workspaceId: string, response: ServerResponse): () => void {
    let clients = this.rooms.get(workspaceId);
    if (!clients) this.rooms.set(workspaceId, clients = new Set());
    clients.add(response);
    return () => {
      clients.delete(response);
      if (!clients.size) this.rooms.delete(workspaceId);
    };
  }

  async hint(hint: RefreshHint): Promise<void> {
    const frame = `event: refresh\ndata: ${JSON.stringify(hint)}\n\n`;
    for (const client of this.rooms.get(hint.workspaceId) ?? []) {
      // Slow peers reconnect and refetch; never grow an unbounded write queue.
      if (client.destroyed || !client.write(frame)) client.destroy();
    }
  }

  close(): void {
    for (const clients of this.rooms.values()) for (const client of clients) client.destroy();
    this.rooms.clear();
  }
}

export function registerRefreshStream(app: FastifyInstance, stream: RefreshStream): void {
  app.get('/api/workspaces/:workspaceId/realtime/stream', async (request, reply) => {
    const { workspaceId } = parseOrThrow(z.object({ workspaceId: uuidSchema }), request.params);
    reply.hijack();
    const response = reply.raw;
    request.raw.socket.setNoDelay(true);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const detach = stream.attach(workspaceId, response);
    response.write('retry: 1000\nevent: ready\ndata: {}\n\n');
    const heartbeat = setInterval(() => {
      if (!response.write(': heartbeat\n\n')) response.destroy();
    }, 15000);
    heartbeat.unref();
    response.on('close', () => { clearInterval(heartbeat); detach(); });
    request.log.debug({ workspaceId }, 'refresh stream connected');
  });
  // onClose is too late: HTTP shutdown would wait for these open responses.
  app.addHook('preClose', async () => stream.close());
}
