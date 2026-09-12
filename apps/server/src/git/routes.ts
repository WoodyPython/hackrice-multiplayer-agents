import { z } from 'zod';
import { ApiError, approvedFilesSchema, approvedFileContentSchema, uuidSchema } from '@app/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { parseOrThrow } from '../http/errors.js';
import type { LocalGitService } from './service.js';

export async function registerApprovedFileRoutes(app: FastifyInstance, deps: { db: Db; git: LocalGitService }) {
  const params = z.object({ workspaceId: uuidSchema });
  async function workspace(value: unknown) {
    const { workspaceId } = parseOrThrow(params, value);
    if (!await deps.db.selectFrom('workspaces').select('id').where('id', '=', workspaceId).executeTakeFirst()) {
      throw new ApiError('WORKSPACE_NOT_FOUND');
    }
    return workspaceId;
  }
  app.get('/api/workspaces/:workspaceId/files', async (request) =>
    approvedFilesSchema.parse(await deps.git.listApprovedFiles(await workspace(request.params))));
  app.get('/api/workspaces/:workspaceId/files/content', async (request, reply) => {
    const workspaceId = await workspace(request.params);
    const { path } = parseOrThrow(z.object({ path: z.string().min(1) }).strict(), request.query);
    reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
    return approvedFileContentSchema.parse(await deps.git.readApprovedFile(workspaceId, path));
  });
}
