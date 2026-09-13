import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ApiError, INVITATION_TTL_MS, SESSION_COOKIE,
  claimWorkspaceRequestSchema, createInvitationRequestSchema, createSessionRequestSchema,
  createdInvitationSchema, invitationPreviewSchema, invitationSchema, membershipSchema,
  preferencesSchema, sessionStateSchema, updateMemberRequestSchema,
  updatePreferencesRequestSchema, uuidSchema, workspaceDirectorySchema,
  workspaceMemberSchema,
} from '@app/contracts';
import type { Transaction } from 'kysely';
import type { Db } from '../db/client.js';
import type { Database } from '../db/types.js';
import { parseOrThrow } from '../http/errors.js';
import { ownerKeyMatches } from '../workspaces/owner-key.js';
import { readSessionCookie, requireAccount, requireAuth } from './authorize.js';
import type { SessionStore } from './sessions.js';

/**
 * Accounts, memberships, and invitations.
 *
 * These are the routes that create authority, so each one states what it treats
 * as proof. The rule underneath all of them: possession of a workspace URL is
 * never evidence of anything. Membership comes from an invitation token or from
 * the legacy owner key, both of which are secrets held only by someone who was
 * actually given them.
 */

const workspaceParams = z.object({ workspaceId: uuidSchema });

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * The session cookie.
 *
 * `httpOnly` keeps it away from script, so an XSS bug cannot read it out.
 * `sameSite: 'lax'` blocks cross-site POSTs from carrying it, which is the CSRF
 * defence for every mutating route behind it, while still allowing an invite
 * link clicked from chat to land signed in. `secure` is on everywhere except
 * plain-HTTP localhost, where the browser would simply drop the cookie.
 */
function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    ...(secure ? ['Secure'] : []),
  ];
  void reply.header('set-cookie', attributes.join('; '));
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.header('set-cookie', [
    `${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

export interface AuthRouteDeps {
  db: Db;
  sessions: SessionStore;
  /** False only for plain-HTTP local development. */
  secureCookies: boolean;
  signInRateLimit: { max: number; timeWindow: string };
  now?: () => Date;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { db, sessions } = deps;
  const now = () => deps.now?.() ?? new Date();

  async function state(userId: string | undefined) {
    if (!userId) return sessionStateSchema.parse({ account: null, workspaces: [], preferences: null });
    const [workspaces, preferences] = await Promise.all([
      // No counts here: this runs on every page load and nothing in the
      // switcher renders them. The home page asks for the full picture.
      sessions.memberships(userId, { summarize: false }), sessions.preferences(userId),
    ]);
    return { workspaces, preferences };
  }

  /**
   * Exchange a Supabase access token for our session.
   *
   * Rate limited: this is the one route that calls the identity provider, and
   * an unauthenticated caller can otherwise use it to hammer Supabase with our
   * key attached.
   */
  app.post('/api/auth/session', { config: { rateLimit: deps.signInRateLimit } }, async (request, reply) => {
    const body = parseOrThrow(createSessionRequestSchema, request.body ?? {});
    const { token, expiresAt, identity } = await sessions.signIn(body.accessToken);
    setSessionCookie(reply, token, expiresAt, deps.secureCookies);
    const rest = await state(identity.userId);
    return reply.code(200).send(sessionStateSchema.parse({ account: identity.account, ...rest }));
  });

  /** Who am I, what do I have, and what are my settings -- in one call. */
  app.get('/api/auth/session', async (request, reply) => {
    const token = readSessionCookie(request.headers.cookie);
    const identity = await sessions.resolve(token);
    const rest = await state(identity?.userId);
    // Keep the browser expiry aligned with the store's sliding session expiry.
    // This runs at application startup and whenever the account is refreshed.
    if (identity && token) setSessionCookie(reply, token, identity.expiresAt, deps.secureCookies);
    void reply.header('cache-control', 'no-store');
    return reply.code(200).send(sessionStateSchema.parse({
      account: identity?.account ?? null, ...rest,
    }));
  });

  app.delete('/api/auth/session', async (request, reply) => {
    await sessions.signOut(readSessionCookie(request.headers.cookie));
    clearSessionCookie(reply, deps.secureCookies);
    return reply.code(204).send();
  });

  /**
   * The home page's list: workspaces I belong to, and workspaces I have opened.
   *
   * Separate from `GET /api/auth/session` because it is read on a different
   * rhythm -- the session once at startup, this whenever the home page is
   * shown or something changes -- and because the visited list is only ever
   * needed here.
   *
   * The second list is not a back door. A visit records that somebody opened a
   * workspace they hold the link to; every request it leads to is authorized
   * against membership exactly as before, and a link holder stays a viewer.
   * What it changes is only that they can find it again: before this, losing
   * the URL lost the workspace, signed in or not.
   */
  app.get('/api/auth/workspaces', async (request, reply) => {
    const identity = await sessions.resolve(readSessionCookie(request.headers.cookie));
    if (!identity) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
    const [workspaces, visited] = await Promise.all([
      sessions.memberships(identity.userId),
      sessions.visited(identity.userId),
    ]);
    return reply.code(200).send(workspaceDirectorySchema.parse({ workspaces, visited }));
  });

  app.patch('/api/auth/preferences', async (request, reply) => {
    const identity = await sessions.resolve(readSessionCookie(request.headers.cookie));
    if (!identity) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
    const patch = parseOrThrow(updatePreferencesRequestSchema, request.body ?? {});
    // A last-workspace pointer must be one of mine, or it is a way to probe
    // which workspace IDs exist by watching which ones persist.
    if (patch.lastWorkspace) {
      const access = await sessions.access(patch.lastWorkspace.toLowerCase(), identity.userId);
      if (access === 'viewer') throw new ApiError('FORBIDDEN', 'That is not one of your workspaces.');
    }
    const saved = await sessions.savePreferences(identity.userId, patch);
    return reply.code(200).send(preferencesSchema.parse(saved));
  });

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  app.get('/api/workspaces/:workspaceId/members', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const auth = requireAuth(request);
    const rows = await db.selectFrom('workspace_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.user_id', 'u.email', 'u.display_name', 'm.role', 'm.created_at'])
      .where('m.workspace_id', '=', workspaceId)
      .orderBy('m.created_at', 'asc')
      .execute();
    return reply.code(200).send({
      members: rows.map((row) => workspaceMemberSchema.parse({
        userId: row.user_id,
        // Addresses are personal data and are not needed to collaborate, so
        // only an owner -- who has to manage the roster -- sees them.
        email: auth.access === 'owner' ? row.email : '',
        displayName: row.display_name,
        role: row.role,
        joinedAt: new Date(row.created_at).toISOString(),
      })),
    });
  });

  /**
   * Leave a workspace.
   *
   * Registered before the `:userId` form and as a static segment, so Fastify
   * matches it first and the authorization gate sees a different route pattern
   * -- which is what lets removing *yourself* be a member action while removing
   * somebody else stays owner-only.
   *
   * A member who cannot leave has only one way out of a workspace they no
   * longer want to be in: asking the person they are trying to stop working
   * with. The last owner still cannot leave, for the same reason they cannot
   * demote themselves: a workspace with no owner can never be administered
   * again by anybody.
   */
  app.delete('/api/workspaces/:workspaceId/members/me', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const auth = requireAccount(request);
    await db.transaction().execute(async (trx) => {
      await assertNotLastOwner(trx, workspaceId, auth.account.id, 'member');
      const removed = await trx.deleteFrom('workspace_members')
        .where('workspace_id', '=', workspaceId).where('user_id', '=', auth.account.id)
        .returning('user_id').executeTakeFirst();
      if (!removed) throw new ApiError('FORBIDDEN', 'You are not a member of this workspace.');
      // The pointer is to "where I was working", and this is no longer one of
      // mine. Left behind, it would send the next sign-in to a workspace the
      // person just chose to leave.
      await trx.updateTable('user_preferences').set({ last_workspace: null })
        .where('user_id', '=', auth.account.id)
        .where('last_workspace', '=', workspaceId).execute();
    });
    return reply.code(204).send();
  });

  app.patch('/api/workspaces/:workspaceId/members/:userId', async (request, reply) => {
    const { workspaceId, userId } = parseOrThrow(
      workspaceParams.extend({ userId: uuidSchema }), request.params);
    const { role } = parseOrThrow(updateMemberRequestSchema, request.body ?? {});
    await db.transaction().execute(async (trx) => {
      await assertNotLastOwner(trx, workspaceId, userId, role);
      const updated = await trx.updateTable('workspace_members').set({ role })
        .where('workspace_id', '=', workspaceId).where('user_id', '=', userId)
        .returning('user_id').executeTakeFirst();
      if (!updated) throw new ApiError('WORKSPACE_NOT_FOUND', 'That person is not in this workspace.');
    });
    return reply.code(204).send();
  });

  app.delete('/api/workspaces/:workspaceId/members/:userId', async (request, reply) => {
    const { workspaceId, userId } = parseOrThrow(
      workspaceParams.extend({ userId: uuidSchema }), request.params);
    await db.transaction().execute(async (trx) => {
      await assertNotLastOwner(trx, workspaceId, userId, 'member');
      await trx.deleteFrom('workspace_members')
        .where('workspace_id', '=', workspaceId).where('user_id', '=', userId).execute();
    });
    return reply.code(204).send();
  });

  /**
   * A workspace must never become ownerless.
   *
   * There is no recovery path from it: with nobody able to administer or
   * invite, the workspace is readable forever and manageable by no one. The
   * count runs under a row lock so two owners cannot each demote the other by
   * clicking at the same moment and both pass the check.
   */
  async function assertNotLastOwner(
    trx: Transaction<Database>, workspaceId: string, userId: string, nextRole: string,
  ): Promise<void> {
    // Serialize roster changes before locking individual members. Locking a
    // different target first lets two owners deadlock while locking each other.
    await trx.selectFrom('workspaces').select('id')
      .where('id', '=', workspaceId).forUpdate().executeTakeFirst();
    // Only a change that removes an owner can strand the workspace.
    const target = await trx.selectFrom('workspace_members').select('role')
      .where('workspace_id', '=', workspaceId).where('user_id', '=', userId)
      .forUpdate().executeTakeFirst();
    if (!target || target.role !== 'owner' || nextRole === 'owner') return;
    // forUpdate on the whole owner set: two owners demoting each other at the
    // same instant must not both read "there are two of us" and both proceed.
    const owners = await trx.selectFrom('workspace_members').select('user_id')
      .where('workspace_id', '=', workspaceId).where('role', '=', 'owner')
      .forUpdate().execute();
    if (owners.length <= 1) {
      throw new ApiError('FORBIDDEN',
        'This is the only owner. Make someone else an owner first, or the workspace would be left with nobody who can manage it.');
    }
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  app.post('/api/workspaces/:workspaceId/invitations', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const body = parseOrThrow(createInvitationRequestSchema, request.body ?? {});
    const auth = requireAccount(request);
    // 32 bytes of CSPRNG. This token is the whole credential, so it has to be
    // unguessable on its own -- the workspace ID in the URL adds nothing.
    const token = randomBytes(32).toString('base64url');
    const created = now();
    const row = await db.insertInto('workspace_invitations').values({
      workspace_id: workspaceId, role: body.role,
      email: body.email?.trim().toLowerCase() ?? null,
      token_hash: hashSecret(token), invited_by: auth.account.id,
      created_at: created, expires_at: new Date(created.getTime() + INVITATION_TTL_MS),
    }).returningAll().executeTakeFirstOrThrow();
    // The only time the token is ever returned. Only its hash is stored.
    return reply.code(201).send(createdInvitationSchema.parse({ ...toInvitation(row), token }));
  });

  app.get('/api/workspaces/:workspaceId/invitations', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const rows = await db.selectFrom('workspace_invitations').selectAll()
      .where('workspace_id', '=', workspaceId).orderBy('created_at', 'desc').limit(100).execute();
    return reply.code(200).send({ invitations: rows.map((row) => invitationSchema.parse(toInvitation(row))) });
  });

  app.delete('/api/workspaces/:workspaceId/invitations/:invitationId', async (request, reply) => {
    const { workspaceId, invitationId } = parseOrThrow(
      workspaceParams.extend({ invitationId: uuidSchema }), request.params);
    await db.updateTable('workspace_invitations').set({ revoked_at: now() })
      .where('id', '=', invitationId).where('workspace_id', '=', workspaceId)
      .where('accepted_at', 'is', null).where('revoked_at', 'is', null).execute();
    return reply.code(204).send();
  });

  /** What the invitee sees before deciding. Requires the token, not the URL. */
  app.get('/api/invitations/:token', async (request, reply) => {
    const { token } = parseOrThrow(z.object({ token: z.string().min(16).max(200) }), request.params);
    const identity = await sessions.resolve(readSessionCookie(request.headers.cookie));
    const invitation = await liveInvitation(token);
    const workspace = await db.selectFrom('workspaces').select('name')
      .where('id', '=', invitation.workspace_id).executeTakeFirstOrThrow();
    return reply.code(200).send(invitationPreviewSchema.parse({
      workspaceName: workspace.name,
      role: invitation.role,
      emailMismatch: invitation.email !== null && identity !== null &&
        identity.account.email.trim().toLowerCase() !== invitation.email,
    }));
  });

  app.post('/api/invitations/:token/accept', async (request, reply) => {
    const { token } = parseOrThrow(z.object({ token: z.string().min(16).max(200) }), request.params);
    const identity = await sessions.resolve(readSessionCookie(request.headers.cookie));
    if (!identity) throw new ApiError('AUTH_REQUIRED', 'Sign in to accept this invitation.');

    const membership = await db.transaction().execute(async (trx) => {
      const invitation = await trx.selectFrom('workspace_invitations').selectAll()
        .where('token_hash', '=', hashSecret(token)).forUpdate().executeTakeFirst();
      const current = now();
      if (!invitation || invitation.revoked_at || invitation.accepted_at ||
          new Date(invitation.expires_at).getTime() <= current.getTime()) {
        throw new ApiError('INVITATION_INVALID', 'That invitation is no longer valid.');
      }
      // A locked invitation is for one address. Without this, an invite
      // forwarded to the wrong chat is a way into the workspace.
      if (invitation.email && invitation.email !== identity.account.email.trim().toLowerCase()) {
        throw new ApiError('INVITATION_INVALID', 'That invitation was issued to a different email address.');
      }
      // Consumed under the same lock that read it, so two tabs racing the same
      // link cannot both succeed.
      await trx.updateTable('workspace_invitations')
        .set({ accepted_at: current, accepted_by: identity.userId })
        .where('id', '=', invitation.id).execute();
      await trx.insertInto('workspace_members').values({
        workspace_id: invitation.workspace_id, user_id: identity.userId,
        role: invitation.role, created_at: current,
      }).onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doNothing()).execute();

      const workspace = await trx.selectFrom('workspaces').select(['id', 'name'])
        .where('id', '=', invitation.workspace_id).executeTakeFirstOrThrow();
      const existing = await trx.selectFrom('workspace_members').select(['role', 'created_at'])
        .where('workspace_id', '=', workspace.id).where('user_id', '=', identity.userId)
        .executeTakeFirstOrThrow();
      return { workspaceId: workspace.id, name: workspace.name, role: existing.role,
        joinedAt: new Date(existing.created_at).toISOString() };
    });
    return reply.code(200).send(membershipSchema.parse(membership));
  });

  // -------------------------------------------------------------------------
  // Claiming a pre-existing guest workspace
  // -------------------------------------------------------------------------

  /**
   * Convert a guest workspace into an owned one.
   *
   * The owner key is the proof, because it is exactly what ownership meant
   * before accounts existed (section 1.2: "ownership belongs to possession of
   * that browser key"). The workspace URL is explicitly not accepted: everyone
   * who was ever sent the link has it, and honouring it would hand every old
   * workspace to whoever opened it first.
   *
   * On success the hash is cleared, so a key that was shared in a chat months
   * ago cannot be replayed to claim co-ownership later.
   */
  app.post('/api/workspaces/:workspaceId/claim', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const body = parseOrThrow(claimWorkspaceRequestSchema, request.body ?? {});
    const auth = requireAccount(request);

    const membership = await db.transaction().execute(async (trx) => {
      const workspace = await trx.selectFrom('workspaces').selectAll()
        .where('id', '=', workspaceId).forUpdate().executeTakeFirst();
      if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');
      if (workspace.owner_key_hash === null) {
        // Already claimed. Say so plainly: this is not a permission failure to
        // be retried, it is a workspace that now has owners to ask.
        throw new ApiError('FORBIDDEN', 'This workspace already belongs to an account. Ask an owner for an invitation.');
      }
      if (!ownerKeyMatches(body.ownerKey, workspace.owner_key_hash)) {
        throw new ApiError('OWNER_KEY_REQUIRED', 'That is not this workspace\'s owner key.');
      }
      const current = now();
      await trx.insertInto('workspace_members').values({
        workspace_id: workspaceId, user_id: auth.account.id, role: 'owner', created_at: current,
      }).onConflict((oc) => oc.columns(['workspace_id', 'user_id'])
        .doUpdateSet({ role: 'owner' })).execute();
      await trx.updateTable('workspaces')
        .set({ owner_key_hash: null, claimed_at: current, updated_at: current })
        .where('id', '=', workspaceId).execute();
      return { workspaceId, name: workspace.name, role: 'owner' as const,
        joinedAt: current.toISOString() };
    });
    return reply.code(200).send(membershipSchema.parse(membership));
  });

  async function liveInvitation(token: string) {
    const invitation = await db.selectFrom('workspace_invitations').selectAll()
      .where('token_hash', '=', hashSecret(token)).executeTakeFirst();
    const current = now();
    if (!invitation || invitation.revoked_at || invitation.accepted_at ||
        new Date(invitation.expires_at).getTime() <= current.getTime()) {
      throw new ApiError('INVITATION_INVALID', 'That invitation is no longer valid.');
    }
    // Constant-time confirmation of the hash we just matched on.
    const stored = Buffer.isBuffer(invitation.token_hash)
      ? invitation.token_hash : Buffer.from(invitation.token_hash);
    if (stored.length !== 32 || !timingSafeEqual(hashSecret(token), stored)) {
      throw new ApiError('INVITATION_INVALID', 'That invitation is no longer valid.');
    }
    return invitation;
  }
}

function toInvitation(row: {
  id: string; role: string; email: string | null;
  created_at: Date | string; expires_at: Date | string;
  accepted_at: Date | string | null; revoked_at: Date | string | null;
}) {
  return {
    id: row.id, role: row.role, email: row.email,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}
