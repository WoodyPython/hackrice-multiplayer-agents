import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidSchema, workspaceChannel } from '@app/contracts';
import { parseOrThrow } from '../http/errors.js';
import type { AppConfig } from '../config.js';
import type { TaskEventService } from './service.js';

/**
 * B06 read surface.
 *
 * A hint tells a browser that something changed; these routes are where it
 * finds out what. Section 5.1: "A realtime event prompts the browser to fetch
 * the authoritative API state."
 */

const taskParams = z.object({ workspaceId: uuidSchema, taskId: uuidSchema });
const workspaceParams = z.object({ workspaceId: uuidSchema });

const listQuery = z.object({
  afterId: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export interface EventRouteDeps {
  events: TaskEventService;
  config: AppConfig;
}

export async function registerEventRoutes(
  app: FastifyInstance,
  deps: EventRouteDeps,
): Promise<void> {
  /**
   * Durable task events (section 11.5).
   *
   * Cursor-paginated by id so a browser that was disconnected reads forward
   * from where it stopped. This is the authoritative progress record; hints are
   * only a prompt to come here.
   */
  app.get('/api/workspaces/:workspaceId/tasks/:taskId/events', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    const query = parseOrThrow(listQuery, request.query ?? {});
    return reply.send(
      await deps.events.listForTask(workspaceId, taskId, {
        ...(query.afterId !== undefined ? { afterId: query.afterId } : {}),
        limit: query.limit,
      }),
    );
  });

  /**
   * What a browser needs to subscribe to refresh hints.
   *
   * Section 5.3: "The browser receives only public service locations and the
   * Supabase publishable key needed for public refresh channels." So this
   * returns exactly those two things and the channel name, and deliberately not
   * the service-role key, the database URL, the model configuration, or the Git
   * data root.
   *
   * `realtime` is null when no project is configured, which is every local run.
   * A client that sees null should poll rather than fail: section 5 specifies
   * polling as the fallback, and the durable events above are authoritative
   * either way.
   */
  app.get('/api/workspaces/:workspaceId/realtime', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);

    const configured =
      deps.config.SUPABASE_URL !== undefined &&
      deps.config.SUPABASE_PUBLISHABLE_KEY !== undefined;

    return reply.send({
      channel: workspaceChannel(workspaceId),
      realtime: configured
        ? {
            url: deps.config.SUPABASE_URL,
            publishableKey: deps.config.SUPABASE_PUBLISHABLE_KEY,
          }
        : null,
    });
  });
}
