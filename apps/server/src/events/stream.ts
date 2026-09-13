import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import {
  announcePresenceRequestSchema, presenceRosterSchema, uuidSchema,
  type PresenceRoster, type RefreshHint,
} from '@app/contracts';
import { PresenceRegistry } from './presence.js';
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
    this.send(hint.workspaceId, 'refresh', hint);
  }

  /** Presence rides the room that already exists rather than a second socket. */
  roster(roster: PresenceRoster): void {
    this.send(roster.workspaceId, 'presence', roster);
  }

  /** Whether anyone is listening, so a sweep can skip silent workspaces. */
  has(workspaceId: string): boolean {
    return (this.rooms.get(workspaceId)?.size ?? 0) > 0;
  }

  private send(workspaceId: string, event: string, payload: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.rooms.get(workspaceId) ?? []) {
      // Slow peers reconnect and refetch; never grow an unbounded write queue.
      if (client.destroyed || !client.write(frame)) client.destroy();
    }
  }

  close(): void {
    for (const clients of this.rooms.values()) for (const client of clients) client.destroy();
    this.rooms.clear();
  }
}

export function registerRefreshStream(app: FastifyInstance, stream: RefreshStream,
  presence = new PresenceRegistry()): void {
  const workspaceParams = z.object({ workspaceId: uuidSchema });
  const broadcast = (workspaceId: string) =>
    stream.roster(presenceRosterSchema.parse({ workspaceId, participants: presence.list(workspaceId) }));

  /**
   * Presence is announced, never inferred from the SSE connection.
   *
   * EventSource cannot set headers, and the alternative -- putting the
   * contributor's chosen label in the stream URL's query string -- would write
   * a name someone may have changed to their own into every access log and
   * proxy along the way. A short POST keeps it in a body.
   */
  app.post('/api/workspaces/:workspaceId/presence', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const entry = parseOrThrow(announcePresenceRequestSchema, request.body);
    // The host marker is the server's to decide. The authorization hook has
    // already resolved this caller's membership, so the roster reports what
    // they actually are rather than what they claimed.
    const isHost = request.auth?.access === 'owner';
    const isAccount = Boolean(request.auth?.account);
    if (presence.announce(workspaceId, { ...entry, isHost, isAccount })) broadcast(workspaceId);
    return reply.code(200).send(presenceRosterSchema.parse({
      workspaceId, participants: presence.list(workspaceId),
    }));
  });

  app.delete('/api/workspaces/:workspaceId/presence/:presenceId', async (request, reply) => {
    const { workspaceId, presenceId } = parseOrThrow(
      workspaceParams.extend({ presenceId: uuidSchema }), request.params);
    if (presence.leave(workspaceId, presenceId)) broadcast(workspaceId);
    return reply.code(204).send();
  });

  app.post('/api/workspaces/:workspaceId/presence/:presenceId/typing', async (request, reply) => {
    const { workspaceId, presenceId } = parseOrThrow(
      workspaceParams.extend({ presenceId: uuidSchema }), request.params);
    const { taskId } = parseOrThrow(z.object({ taskId: uuidSchema.nullable() }).strict(), request.body);
    if (presence.setTyping(workspaceId, presenceId, taskId)) broadcast(workspaceId);
    return reply.code(204).send();
  });

  app.get('/api/workspaces/:workspaceId/presence', async (request) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    return presenceRosterSchema.parse({ workspaceId, participants: presence.list(workspaceId) });
  });

  // Someone who closed a laptop never sends a leave, so the roster is swept.
  const sweep = setInterval(() => {
    for (const workspaceId of presence.sweep()) if (stream.has(workspaceId)) broadcast(workspaceId);
  }, 15000);
  sweep.unref();
  app.addHook('preClose', async () => clearInterval(sweep));

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
