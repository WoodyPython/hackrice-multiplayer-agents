import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  OWNER_KEY_HEADER,
  createWorkspaceRequestSchema,
  deleteWorkspaceRequestSchema,
  deleteWorkspaceResponseSchema,
  setWorkspaceStatusRequestSchema,
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
 * There is deliberately no route that lists workspaces here, and section 1.2's
 * prohibition -- "do not expose an endpoint returning everyone's workspaces" --
 * is still exactly in force. `GET /api/auth/workspaces` is not an exception to
 * it: it returns the caller's own memberships and their own visit history, both
 * scoped to the account making the request. Nothing enumerates the table, and
 * if you are ever tempted to add that for an admin view, do not.
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

    /**
     * Remember that this account opened this workspace.
     *
     * Not membership and not authority: it is this person's own history, and
     * it is what makes "the workspace somebody sent me a link to last week"
     * findable again from any device instead of living in whichever browser
     * tab they happened to keep open. Throttled in the store, so navigating
     * around inside a workspace costs one write, not one per page.
     *
     * Awaited rather than fired and forgotten: an unhandled rejection from a
     * floating promise takes the process down, and this is the read every page
     * in the app performs.
     */
    if (auth.account) {
      try {
        await deps.sessions.recordVisit(workspaceId, auth.account.id);
      } catch (error) {
        // History is a convenience. Losing an entry must never fail the read
        // that was actually asked for.
        request.log.warn({ err: error, workspaceId }, 'could not record workspace visit');
      }
    }

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

  /**
   * Archive or restore. Owner only.
   *
   * Reversible, and nothing is removed: the workspace drops out of the everyday
   * list and refuses writes, and every task, file, and review stays exactly
   * where it was. It exists so "we are finished with this" does not have to
   * mean "destroy it" -- which is the only option when delete is the only verb,
   * and is why people instead leave everything lying around forever.
   *
   * The authorization hook allows this route on an already-archived workspace;
   * an archive nobody can come back from is a delete with a gentler name.
   */
  app.patch('/api/workspaces/:workspaceId/status', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const { status } = parseOrThrow(setWorkspaceStatusRequestSchema, request.body ?? {});
    const updated = await deps.workspaces.setStatus(workspaceId, status);
    return reply.send(updated);
  });

  /**
   * Delete the workspace and everything in it. Owner only, irreversible.
   *
   * Two deliberate choices:
   *
   * **It is a real delete, not a flag.** A soft delete reclaims nothing, and
   * the reason this endpoint exists is that an abandoned workspace keeps its
   * events, drafts, model call records, and uploaded bytes forever on a
   * fixed-size free-tier database. Archiving is the reversible option and it is
   * one click away; this one is for when the answer is genuinely "get rid of
   * it".
   *
   * **The name has to be typed back**, checked in the service. Not security --
   * the gate already proved ownership -- but the gap between meaning to do this
   * and having clicked the wrong row in a list.
   */
  app.delete('/api/workspaces/:workspaceId', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const body = parseOrThrow(deleteWorkspaceRequestSchema, request.body ?? {});
    const summary = await deps.workspaces.destroy({ workspaceId, confirmName: body.confirmName });
    return reply.send(deleteWorkspaceResponseSchema.parse(summary));
  });
}
