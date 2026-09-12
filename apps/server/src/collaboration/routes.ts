import { z } from 'zod';
import { draftCaptureSchema, uuidSchema, type CollaborationService } from '@app/contracts';
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '../http/errors.js';

const params = z.object({ workspaceId: uuidSchema, taskId: uuidSchema });
const body = z.object({}).strict();

/** Capture authoritative server state; browsers cannot supply replacement text. */
export async function registerCheckpointRoutes(app: FastifyInstance,
  collaboration: Pick<CollaborationService, 'capture'>): Promise<void> {
  app.post('/api/workspaces/:workspaceId/tasks/:taskId/checkpoint', async (request, reply) => {
    const input = parseOrThrow(params, request.params);
    parseOrThrow(body, request.body === undefined ? {} : request.body);
    return reply.status(200).send(draftCaptureSchema.parse(await collaboration.capture(input)));
  });
}
