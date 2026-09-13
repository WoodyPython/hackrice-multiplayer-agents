import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, SESSION_COOKIE, canAdminister, canWrite, uuidSchema,
  type AccessLevel, type Account } from '@app/contracts';
import type { SessionStore } from './sessions.js';

/**
 * One gate in front of every workspace route.
 *
 * All but one of this server's routes live under
 * `/api/workspaces/:workspaceId/...`, which is what makes a single `preHandler`
 * possible. That matters more than the line count it saves: a rule applied in
 * one place cannot be forgotten on the forty-sixth handler, and a route added
 * next week is covered before anyone remembers to think about it.
 *
 * **Writes are denied by default.** The requirement for a route is derived from
 * its HTTP method -- anything that is not a GET or HEAD needs membership -- and
 * the exceptions are listed explicitly below. A new mutating route is therefore
 * member-only until somebody deliberately writes it down as otherwise, rather
 * than being public until somebody remembers to protect it.
 *
 * **Matching is on the registered route pattern, never the raw URL.** Fastify
 * has already matched and parsed the path by this point, so there is no
 * encoding, casing, or traversal trick that can make `/tasks/../admin` look
 * like something it is not.
 */

/** What a route needs. `viewer` means a link holder, signed in or not. */
type Requirement = AccessLevel | 'account';

/**
 * Routes that administer the workspace itself: who belongs to it, what it is
 * called, and what the agents are told. Owners only.
 */
const OWNER_ONLY = new Set([
  'PATCH /api/workspaces/:workspaceId',
  'PATCH /api/workspaces/:workspaceId/status',
  'DELETE /api/workspaces/:workspaceId',
  'POST /api/workspaces/:workspaceId/invitations',
  'GET /api/workspaces/:workspaceId/invitations',
  'DELETE /api/workspaces/:workspaceId/invitations/:invitationId',
  'PATCH /api/workspaces/:workspaceId/members/:userId',
  'DELETE /api/workspaces/:workspaceId/members/:userId',
  // `DELETE .../members/me` is NOT here. Leaving is not administration, and a
  // member who cannot leave has no way out of a workspace but to ask the
  // person they are trying to stop working with. Fastify matches the static
  // segment first, so the two are separate patterns and separate rules.
  //
  // Task moves are NOT listed here: marking work complete is member-level and
  // only the other transitions are owner-level, which depends on the request
  // body. PgTaskService.move draws that line with the resolved role.
]);

/**
 * Writes a read-only visitor may still make.
 *
 * Presence only. Someone reading over a shared link genuinely is in the room,
 * and saying so is useful; the roster is ephemeral, carries no authority, and
 * section 5.1 already assumes its contents can be forged by a link holder.
 */
const VIEWER_WRITES = new Set([
  'POST /api/workspaces/:workspaceId/presence',
  'DELETE /api/workspaces/:workspaceId/presence/:presenceId',
  'POST /api/workspaces/:workspaceId/presence/:presenceId/typing',
]);

/**
 * Signed in, but membership not required -- because these are how you get it.
 *
 * Claiming needs the owner key as its proof and is checked in the handler.
 */
const ACCOUNT_ONLY = new Set([
  'POST /api/workspaces/:workspaceId/claim',
]);

/** The member list names colleagues, so it is not for link holders. */
const MEMBER_READS = new Set([
  'GET /api/workspaces/:workspaceId/members',
]);

/**
 * Writes that still work on an archived workspace.
 *
 * Archiving stops the work, not the administration of it. Restoring is the
 * obvious one -- an archive you cannot come back from is a delete with a softer
 * name -- and deleting has to work too, or tidying up would require un-tidying
 * first. Leaving is here because being archived is not a reason to be stuck in
 * a workspace.
 */
const ARCHIVED_WRITES = new Set([
  'PATCH /api/workspaces/:workspaceId/status',
  'DELETE /api/workspaces/:workspaceId',
  'DELETE /api/workspaces/:workspaceId/members/me',
]);

export interface RequestAuth {
  workspaceId: string;
  account: Account | null;
  access: AccessLevel;
  /** Read-only because it has been put away, not because of who is asking. */
  archived: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
  interface FastifyInstance {
    /** Exposed so the WebSocket upgrade can authorize with the same store. */
    sessions: SessionStore;
  }
}

/** Cookies, without pulling in a parser for the one cookie we set. */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    // A quoted cookie value is legal; strip the quotes before hashing.
    try {
      return decodeURIComponent(value.replace(/^"|"$/g, '')) || undefined;
    } catch {
      // A malformed browser cookie is an invalid credential, not a server error.
      return undefined;
    }
  }
  return undefined;
}

function requirementFor(method: string, route: string): Requirement {
  // Fastify exposes HEAD for GET routes; it must inherit the same permission.
  const key = `${method === 'HEAD' ? 'GET' : method} ${route}`;
  if (ACCOUNT_ONLY.has(key)) return 'account';
  if (OWNER_ONLY.has(key)) return 'owner';
  if (MEMBER_READS.has(key)) return 'member';
  if (VIEWER_WRITES.has(key)) return 'viewer';
  return method === 'GET' || method === 'HEAD' ? 'viewer' : 'member';
}

function routePattern(request: FastifyRequest): string {
  // `routeOptions.url` is the registered pattern. Falling back to the raw URL
  // would be a hole, so an unknown pattern denies instead: a route we cannot
  // classify is not a route we should let through.
  return request.routeOptions?.url ?? '';
}

export function registerAuthorization(app: FastifyInstance, sessions: SessionStore): void {
  app.addHook('preHandler', async (request) => {
    const route = routePattern(request);
    if (!route.startsWith('/api/workspaces/:workspaceId')) return;

    const params = request.params as { workspaceId?: string } | undefined;
    // Validated here, BEFORE the membership lookup. `workspace_id` is a uuid
    // column, so a path like `../../etc/passwd` would otherwise reach Postgres
    // as a malformed uuid and surface as a 500 -- turning a rejected input into
    // an internal error, and doing it inside the security check of all places.
    const parsed = uuidSchema.safeParse(params?.workspaceId);
    if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'That is not a valid workspace.');
    const workspaceId = parsed.data.toLowerCase();

    const identity = await sessions.resolve(readSessionCookie(request.headers.cookie));
    // One query for both questions. Asking separately would mean two round
    // trips on every request and two different moments to decide against.
    const { access, archived } = await sessions.workspaceAccess(workspaceId, identity?.userId);
    const auth: RequestAuth = { workspaceId, account: identity?.account ?? null, access, archived };
    request.auth = auth;

    const requirement = requirementFor(request.method, route);
    if (requirement === 'account') {
      if (!identity) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
      return;
    }
    if (requirement === 'owner' && !canAdminister(access)) {
      throw unauthorized(identity !== null, 'Only a workspace owner can do that.');
    }
    if (requirement === 'member' && !canWrite(access)) {
      throw unauthorized(identity !== null, 'Join this workspace to make changes.');
    }
    /**
     * An archived workspace is read-only, and that is decided here for the same
     * reason membership is: a rule applied once in front of every route cannot
     * be forgotten on the one route that was added last. Reads are untouched --
     * the whole point of archiving rather than deleting is that the work stays
     * legible -- and the exceptions are the three writes that administer the
     * archive itself.
     */
    if (archived && requirement !== 'viewer' && !ARCHIVED_WRITES.has(`${request.method} ${route}`)) {
      throw new ApiError('WORKSPACE_ARCHIVED',
        'This workspace is archived. An owner can restore it from workspace settings.');
    }
  });
}

/**
 * "Sign in" and "you are signed in, but this is not yours" are different
 * problems with different next steps, so they get different codes. Collapsing
 * them is how a permission failure gets mistaken for a broken login.
 */
function unauthorized(signedIn: boolean, message: string): ApiError {
  return signedIn
    ? new ApiError('FORBIDDEN', message)
    : new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
}

/** For handlers that need the resolved caller. Never optional at use sites. */
export function requireAuth(request: FastifyRequest): RequestAuth {
  if (!request.auth) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  return request.auth;
}

export function requireAccount(request: FastifyRequest): RequestAuth & { account: Account } {
  const auth = requireAuth(request);
  if (!auth.account) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  return auth as RequestAuth & { account: Account };
}
