import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BRIEFING_SESSION_HEADER,
  briefingSchema,
  generateBriefingRequestSchema,
  listBriefingsResponseSchema,
  uuidSchema,
} from '@app/contracts';
import { parseOrThrow } from '../http/errors.js';
import type { BriefingService } from './service.js';

const workspaceParams = z.object({ workspaceId: uuidSchema });
/** A random per-browser key. It scopes history; it grants nothing. */
const sessionHeader = z.object({ [BRIEFING_SESSION_HEADER]: uuidSchema });

/**
 * Generation calls a paid model on behalf of anyone holding the link, so it is
 * throttled per client. Reading history is not.
 */
export const BRIEFING_RATE_LIMIT = { max: 12, timeWindow: '1 minute' };

export async function registerBriefingRoutes(
  app: FastifyInstance,
  deps: { briefings: BriefingService; rateLimit?: { max: number; timeWindow: string } },
): Promise<void> {
  app.get('/api/workspaces/:workspaceId/briefings', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const session = parseOrThrow(sessionHeader, request.headers)[BRIEFING_SESSION_HEADER];
    reply.header('cache-control', 'no-store');
    return listBriefingsResponseSchema.parse(await deps.briefings.list(workspaceId.toLowerCase(), session.toLowerCase()));
  });

  app.post(
    '/api/workspaces/:workspaceId/briefings',
    { config: { rateLimit: deps.rateLimit ?? BRIEFING_RATE_LIMIT } },
    async (request, reply) => {
      const { workspaceId } = parseOrThrow(workspaceParams, request.params);
      const session = parseOrThrow(sessionHeader, request.headers)[BRIEFING_SESSION_HEADER];
      const { window } = parseOrThrow(generateBriefingRequestSchema, request.body ?? {});
      reply.header('cache-control', 'no-store');
      // Parsed on the way out: the schema is the whitelist of what may leave.
      return briefingSchema.parse(await deps.briefings.generate(workspaceId.toLowerCase(), session.toLowerCase(), window));
    },
  );
}
