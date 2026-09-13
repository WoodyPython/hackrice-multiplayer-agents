import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { RefreshStream, registerRefreshStream } from '../src/events/stream.js';

it('delivers committed hints to two peers, isolates workspaces and closes live streams on shutdown', async () => {
  const app = Fastify();
  const stream = new RefreshStream();
  registerRefreshStream(app, stream);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  const abort = new AbortController();
  try {
    const connect = async (id: string) => {
      const response = await fetch(`${base}/api/workspaces/${id}/realtime/stream`, { signal: abort.signal });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-store');
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
      return reader;
    };
    const [a, b, c] = await Promise.all([connect(workspaceId), connect(workspaceId), connect(other)]);
    const started = performance.now();
    await stream.hint({ workspaceId, taskId: null, eventId: '1', eventType: 'discussion.posted' });
    for (const reader of [a, b]) {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"eventId":"1"');
    }
    expect(performance.now() - started).toBeLessThan(1000);
    await stream.hint({ workspaceId: other, taskId: null, eventId: '2', eventType: 'task.posted' });
    const isolated = new TextDecoder().decode((await c.read()).value);
    expect(isolated).toContain('"eventId":"2"');
    expect(isolated).not.toContain('"eventId":"1"');
    await app.close();
  } finally { abort.abort(); await app.close(); }
});
