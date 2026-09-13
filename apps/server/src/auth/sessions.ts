import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  SESSION_TTL_MS, TERMINAL_TASK_STATUSES,
  type AccessLevel, type Account, type Membership, type Preferences,
  type VisitedWorkspace,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { IdentityVerifier } from './supabase.js';

/**
 * Our own session, issued after Supabase has vouched for the account.
 *
 * Why not simply pass the provider's JWT on every request:
 *
 * - **Transport.** `EventSource` cannot set headers and neither can a browser
 *   WebSocket upgrade. This app has both. A cookie is carried by all three
 *   transports, so there is one authentication path rather than one that works
 *   and two that silently do not.
 * - **Revocation.** Signing out has to mean something immediately. A JWT stays
 *   valid until it expires no matter what we do; a row we can delete does not.
 * - **Blast radius.** The provider token never has to live in browser storage,
 *   so an XSS bug cannot walk off with credentials for the identity provider
 *   itself.
 *
 * Only the SHA-256 of the token is stored, for the same reason the owner key
 * was only ever stored hashed: reading the database must not yield live
 * credentials.
 */

/**
 * How stale a visit has to be before opening a workspace rewrites the row.
 *
 * Five minutes: long enough that moving between tabs inside one workspace costs
 * a single write, short enough that "recently opened" means it.
 */
const VISIT_THROTTLE_MS = 5 * 60 * 1000;

/** 32 bytes from the CSPRNG, base64url. Not guessable, not a password. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export interface SessionIdentity {
  userId: string;
  account: Account;
}

export class SessionStore {
  constructor(
    private readonly deps: { db: Db; verify: IdentityVerifier; now?: () => Date },
  ) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /**
   * Exchange a verified provider token for one of our sessions.
   *
   * The upsert is keyed on `supabase_user_id`, never on email: an address can
   * change at the provider, and keying on it would either orphan the account or
   * let a reused address inherit somebody else's memberships.
   */
  async signIn(accessToken: string): Promise<{ token: string; expiresAt: Date; identity: SessionIdentity }> {
    const verified = await this.deps.verify(accessToken);
    const now = this.now();
    const token = mintToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    const identity = await this.deps.db.transaction().execute(async (trx) => {
      const user = await trx.insertInto('users')
        .values({
          supabase_user_id: verified.supabaseUserId,
          email: verified.email,
          display_name: verified.displayName,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('supabase_user_id').doUpdateSet({
          // The provider owns the address and the name; refresh both on every
          // sign-in so a change there does not leave us showing stale details.
          email: verified.email,
          display_name: verified.displayName,
          updated_at: now,
        }))
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx.insertInto('sessions').values({
        user_id: user.id, token_hash: hashToken(token),
        created_at: now, last_seen_at: now, expires_at: expiresAt,
      }).execute();

      // Housekeeping on a path that already holds a transaction, rather than a
      // background sweep: expired rows are useless and unbounded growth is not.
      await trx.deleteFrom('sessions').where('expires_at', '<=', now).execute();

      return {
        userId: user.id,
        account: { id: user.id, email: user.email, displayName: user.display_name },
      };
    });

    return { token, expiresAt, identity };
  }

  /**
   * Resolve a cookie to an account, or null.
   *
   * Null is returned for every failure — absent, malformed, unknown, expired —
   * so a caller cannot distinguish them and turn this into an oracle.
   */
  async resolve(token: string | undefined): Promise<SessionIdentity | null> {
    if (!token || token.length < 16 || token.length > 512) return null;
    const now = this.now();
    const row = await this.deps.db.selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select(['sessions.id as session_id', 'sessions.token_hash', 'sessions.expires_at',
        'sessions.last_seen_at', 'users.id as user_id', 'users.email', 'users.display_name'])
      .where('sessions.token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (!row) return null;

    // The lookup already matched on the hash, so this is belt-and-braces
    // against a future change that widens the query into something comparable
    // by prefix. Constant-time either way.
    const stored = Buffer.isBuffer(row.token_hash) ? row.token_hash : Buffer.from(row.token_hash);
    if (stored.length !== 32 || !timingSafeEqual(hashToken(token), stored)) return null;
    if (new Date(row.expires_at).getTime() <= now.getTime()) return null;

    // Sliding expiry, written at most once a day. Refreshing on every request
    // would make an authenticated GET a write, which this app does a lot of.
    const lastSeen = new Date(row.last_seen_at).getTime();
    if (now.getTime() - lastSeen > 24 * 60 * 60 * 1000) {
      await this.deps.db.updateTable('sessions')
        .set({ last_seen_at: now, expires_at: new Date(now.getTime() + SESSION_TTL_MS) })
        .where('id', '=', row.session_id).execute();
    }

    return {
      userId: row.user_id,
      account: { id: row.user_id, email: row.email, displayName: row.display_name },
    };
  }

  /** Sign out this browser. Other sessions for the account are untouched. */
  async signOut(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.deps.db.deleteFrom('sessions').where('token_hash', '=', hashToken(token)).execute();
  }

  /**
   * Every workspace this account belongs to.
   *
   * Ordered by last activity, not by name. Alphabetical is fine for three
   * workspaces and useless for twenty: the one somebody wants is nearly always
   * the one something happened in most recently, and a switcher that makes them
   * read a list to find it is a switcher they stop using.
   *
   * Archived workspaces are included and flagged rather than filtered out here.
   * The switcher hides them and the home page gives them their own section --
   * one query, and the caller decides, instead of two nearly identical reads
   * that can disagree about what "yours" means.
   *
   * `summarize: false` skips the two correlated counts, for the sign-in path
   * where nothing renders them.
   */
  async memberships(userId: string, options: { summarize?: boolean } = {}): Promise<Membership[]> {
    const summarize = options.summarize ?? true;
    let query = this.deps.db.selectFrom('workspace_members as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
      .select(['m.workspace_id', 'w.name', 'm.role', 'm.created_at',
        'w.last_activity_at', 'w.status'])
      .where('m.user_id', '=', userId)
      .orderBy('w.last_activity_at', 'desc')
      // A bound, because this is on the session payload every page load reads.
      // Nobody navigates a list of fifty by scrolling it anyway.
      .limit(50);
    if (summarize) {
      query = query.select((eb) => [
        eb.selectFrom('workspace_members as c').select(({ fn }) => fn.countAll<string>().as('n'))
          .whereRef('c.workspace_id', '=', 'm.workspace_id').as('member_count'),
        eb.selectFrom('tasks as t').select(({ fn }) => fn.countAll<string>().as('n'))
          .whereRef('t.workspace_id', '=', 'm.workspace_id')
          // "Open" is the contract's definition of not-settled, so this count
          // cannot drift from what the board calls finished.
          .where('t.status', 'not in', [...TERMINAL_TASK_STATUSES])
          .as('open_task_count'),
      ]);
    }
    const rows = await query.execute();
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      role: row.role,
      joinedAt: new Date(row.created_at).toISOString(),
      lastActivityAt: new Date(row.last_activity_at).toISOString(),
      archived: row.status === 'archived',
      ...(summarize ? {
        memberCount: Number((row as { member_count?: string }).member_count ?? 0),
        openTaskCount: Number((row as { open_task_count?: string }).open_task_count ?? 0),
      } : {}),
    }));
  }

  async preferences(userId: string): Promise<Preferences> {
    const row = await this.deps.db.selectFrom('user_preferences')
      .selectAll().where('user_id', '=', userId).executeTakeFirst();
    return {
      theme: (row?.theme as Preferences['theme']) ?? 'system',
      lastWorkspace: row?.last_workspace ?? null,
    };
  }

  async savePreferences(userId: string, patch: Partial<Preferences>): Promise<Preferences> {
    const now = this.now();
    const current = await this.preferences(userId);
    const next = { ...current, ...patch };
    await this.deps.db.insertInto('user_preferences')
      .values({ user_id: userId, theme: next.theme, last_workspace: next.lastWorkspace, updated_at: now })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({
        theme: next.theme, last_workspace: next.lastWorkspace, updated_at: now,
      }))
      .execute();
    return next;
  }

  /**
   * What this account may do in this workspace.
   *
   * A membership row decides it. Absence of one is `viewer` -- read-only link
   * access -- and never anything more, whether or not the caller is signed in.
   */
  async access(workspaceId: string, userId: string | undefined): Promise<AccessLevel> {
    if (!userId) return 'viewer';
    const row = await this.deps.db.selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.role ?? 'viewer';
  }

  /**
   * Access and workspace state together, in one query.
   *
   * The authorization gate needs both -- what this person may do, and whether
   * the workspace is accepting changes at all -- and asking twice would mean
   * two round trips on every request, plus the possibility of deciding against
   * two different moments in time.
   *
   * `exists` is reported rather than thrown on: a missing workspace is a 404
   * from the handler that knows what was being asked for, not a permission
   * error from the gate.
   */
  async workspaceAccess(workspaceId: string, userId: string | undefined): Promise<{
    access: AccessLevel; exists: boolean; archived: boolean;
  }> {
    const row = await this.deps.db
      .selectFrom('workspaces as w')
      .leftJoin('workspace_members as m', (join) => join
        .onRef('m.workspace_id', '=', 'w.id')
        // A literal rather than a parameter when signed out, so the join simply
        // matches nothing instead of the query being built two different ways.
        .on('m.user_id', '=', userId ?? '00000000-0000-0000-0000-000000000000'))
      .select(['w.status', 'm.role'])
      .where('w.id', '=', workspaceId)
      .executeTakeFirst();
    if (!row) return { access: 'viewer', exists: false, archived: false };
    return {
      access: userId ? (row.role ?? 'viewer') : 'viewer',
      exists: true,
      archived: row.status === 'archived',
    };
  }

  /**
   * Record that this account opened this workspace.
   *
   * Grants nothing. It is one person's own history, and it exists because
   * "workspaces I have the link to" was previously unrecoverable: lose the URL
   * and the workspace was gone, account or no account.
   *
   * Throttled to one write per window. A workspace page issues a read on every
   * navigation within it, and turning each of those into an UPDATE would make
   * browsing a workspace more write traffic than working in one.
   */
  async recordVisit(workspaceId: string, userId: string): Promise<void> {
    const now = this.now();
    await this.deps.db.insertInto('workspace_visits')
      .values({ user_id: userId, workspace_id: workspaceId, first_seen_at: now, last_seen_at: now })
      .onConflict((oc) => oc.columns(['user_id', 'workspace_id']).doUpdateSet({ last_seen_at: now })
        .where('workspace_visits.last_seen_at', '<', new Date(now.getTime() - VISIT_THROTTLE_MS)))
      .execute();
  }

  /**
   * Workspaces this account has opened but does not belong to.
   *
   * Members are excluded because they are already in `memberships()`, and a
   * workspace appearing in both lists would read as two different things.
   */
  async visited(userId: string, limit = 12): Promise<VisitedWorkspace[]> {
    const rows = await this.deps.db.selectFrom('workspace_visits as v')
      .innerJoin('workspaces as w', 'w.id', 'v.workspace_id')
      .leftJoin('workspace_members as m', (join) => join
        .onRef('m.workspace_id', '=', 'v.workspace_id').on('m.user_id', '=', userId))
      .select(['v.workspace_id', 'w.name', 'w.status', 'v.last_seen_at'])
      .where('v.user_id', '=', userId)
      .where('m.user_id', 'is', null)
      .orderBy('v.last_seen_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      archived: row.status === 'archived',
    }));
  }
}
