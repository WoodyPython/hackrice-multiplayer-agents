import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  OWNER_KEY_HEADER,
  createWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
  uuidSchema,
} from '@app/contracts';
import { parseOrThrow } from '../http/errors.js';
import { readOwnerKeyHeader } from './owner-key.js';
import type { PgWorkspaceService } from './service.js';

/**
 * Public workspace routes (design section 12.1).
 *
 * There is deliberately no route that lists workspaces (section 1.2: "Do not
 * list workspaces publicly or expose an endpoint returning everyone's
 * workspaces"). If you are ever tempted to add one for an admin view, do not.
 */

/**
 * Validating the ID as a UUID at the boundary is what makes section 12.1's
 * "a caller cannot pass an arbitrary room name that opens a filesystem path"
 * true. Workspace IDs reach /data/repos/<id>.git and Yjs room names.
 */
const workspaceParams = z.object({ workspaceId: uuidSchema });

export interface WorkspaceRouteDeps {
  workspaces: PgWorkspaceService;
  createRateLimit: { max: number; timeWindow: string };
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: WorkspaceRouteDeps,
): Promise<void> {
  /**
   * Create.
   *
   * Rate limited (section 3.4): unauthenticated, nothing lists workspaces, and
   * each one occupies a repository on a fixed-size disk, so unbounded creation
   * is an unrecoverable storage leak.
   *
   * The response body carries the owner key. It is the only time it is ever
   * returned, and Fastify does not log response bodies, which is load-bearing
   * here (section 13.3).
   */
  app.post(
    '/api/workspaces',
    { config: { rateLimit: deps.createRateLimit } },
    async (request, reply) => {
      const body = parseOrThrow(createWorkspaceRequestSchema, request.body ?? {});
      const created = await deps.workspaces.create(body);
      return reply.status(201).send(created);
    },
  );

  /** Read. Anyone with the link; the key only decides `isOwner`. */
  app.get('/api/workspaces/:workspaceId', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const ownerKey = readOwnerKeyHeader(request.headers[OWNER_KEY_HEADER]);

    const workspace = await deps.workspaces.resolve(workspaceId, ownerKey);
    if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');

    return reply.send(workspace);
  });

  /**
   * Update name, purpose, or guidance. Owner only (section 1.4).
   *
   * The not-found check runs before the key check, so an unknown ID reports
   * WORKSPACE_NOT_FOUND rather than a permission error. That reveals only that
   * a given UUID exists, and possessing that UUID is already the capability to
   * read the workspace.
   */
  app.patch('/api/workspaces/:workspaceId', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const body = parseOrThrow(updateWorkspaceRequestSchema, request.body ?? {});
    const ownerKey = readOwnerKeyHeader(request.headers[OWNER_KEY_HEADER]);

    const existing = await deps.workspaces.resolve(workspaceId);
    if (!existing) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');

    const isOwner = await deps.workspaces.checkOwnerKey(workspaceId, ownerKey);
    if (!isOwner) {
      // Same code and message whether the header was absent or wrong, so a
      // caller cannot use the response to tell one from the other.
      throw new ApiError(
        'OWNER_KEY_REQUIRED',
        'This action requires the workspace owner key.',
      );
    }

    const updated = await deps.workspaces.updateGuidance(workspaceId, body);
    return reply.send(updated);
  });
}
