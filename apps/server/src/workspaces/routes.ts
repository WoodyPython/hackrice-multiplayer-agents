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
import { readSessionCookie, requireAuth } from '../auth/authorize.js';
import type { SessionStore } from '../auth/sessions.js';
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
  sessions: SessionStore;
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
      // Sign-in is required to create. Anonymous creation would mint a
      // workspace whose only credential is a key in one browser -- the thing
      // accounts exist to replace -- and nobody could later be invited to it.
      const identity = await deps.sessions.resolve(readSessionCookie(request.headers.cookie));
      if (!identity) throw new ApiError('AUTH_REQUIRED', 'Sign in to create a workspace.');
      const created = await deps.workspaces.create({ ...body, ownerUserId: identity.userId });
      return reply.status(201).send(created);
    },
  );

  /**
   * Read. Members and link holders alike; membership decides `isOwner`.
   *
   * The authorization hook has already resolved the caller's access, so this
   * handler does not re-derive it and cannot disagree with the gate.
   */
  app.get('/api/workspaces/:workspaceId', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const auth = requireAuth(request);

    const workspace = await deps.workspaces.resolve(workspaceId, auth.access === 'owner');
    if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');

    return reply.send({
      ...workspace,
      access: auth.access,
      // Lets the UI offer "claim this workspace" instead of a dead end when
      // somebody opens an old guest link while signed in.
      unclaimed: await deps.workspaces.isUnclaimed(workspaceId),
    });
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

    // Owner-only, enforced by the authorization hook before this runs. The
    // not-found check stays here so an unknown ID still reports WORKSPACE_NOT_FOUND.
    const existing = await deps.workspaces.resolve(workspaceId);
    if (!existing) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');

    const updated = await deps.workspaces.updateGuidance(workspaceId, body);
    return reply.send(updated);
  });
}
