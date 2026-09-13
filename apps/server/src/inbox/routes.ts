import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidSchema } from '@app/contracts';
import type { Db } from '../db/client.js';
import { parseOrThrow } from '../http/errors.js';
import { listInbox } from './service.js';

export function registerInboxRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/workspaces/:workspaceId/inbox', async (request) => {
    const { workspaceId } = parseOrThrow(z.object({ workspaceId: uuidSchema }), request.params);
    return { items: await listInbox(db, workspaceId) };
  });
}
