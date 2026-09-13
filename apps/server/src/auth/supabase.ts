import { ApiError } from '@app/contracts';
import type { AppConfig } from '../config.js';
import { supabaseHeaders } from '../supabase-auth.js';

/**
 * Verifying a Supabase access token, server-side.
 *
 * This is the trust boundary of the whole feature: everything downstream treats
 * the returned identity as true, so it is worth being explicit about what makes
 * it trustworthy.
 *
 * **We ask Supabase, rather than decoding the token ourselves.** Local JWT
 * verification would need the project's JWT secret in our environment and would
 * still accept a token that had been revoked seconds earlier. One call to
 * `/auth/v1/user` is authoritative, happens exactly once per sign-in (not per
 * request, because we mint our own session afterwards), and cannot be fooled by
 * a forged signature.
 *
 * **A failure is never treated as success.** A network error, a 5xx, or a
 * malformed body all deny. There is no "assume valid if the provider is down"
 * path, because that is indistinguishable from an attacker taking the provider
 * offline.
 */

export interface VerifiedIdentity {
  supabaseUserId: string;
  email: string;
  displayName: string;
}

/** Supabase returns far more than this; we deliberately read only these. */
interface SupabaseUser {
  id?: unknown;
  email?: unknown;
  user_metadata?: { full_name?: unknown; name?: unknown } | null;
}

const CONTROL_CHARACTERS = new RegExp('[\u0000-\u001f\u007f]', 'g');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A display name we are willing to show to other people in a workspace.
 *
 * `user_metadata` is writable by the account holder, so it is untrusted input
 * that lands next to other members' names. It is trimmed, length-capped, and
 * stripped of control characters; anything left unusable falls back to the
 * local part of the email rather than rendering blank.
 */
function safeDisplayName(user: SupabaseUser, email: string): string {
  const metadata = user.user_metadata ?? {};
  const claimed = [metadata.full_name, metadata.name].find((value) => typeof value === 'string');
  const cleaned = typeof claimed === 'string'
    ? claimed.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    : '';
  if (cleaned) return cleaned;
  const local = email.split('@')[0] ?? '';
  return local.slice(0, 80) || 'Member';
}

export type IdentityVerifier = (accessToken: string) => Promise<VerifiedIdentity>;

export function createSupabaseVerifier(
  config: Pick<AppConfig, 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY'>,
  fetchImpl: typeof fetch = fetch,
): IdentityVerifier {
  return async (accessToken: string): Promise<VerifiedIdentity> => {
    /*
     * Checked here, not at construction.
     *
     * Everything except signing in works without a Supabase project -- the same
     * courtesy section 5.1 extends to realtime -- so a missing key must not
     * stop the server booting. It fails at the one operation that needs it,
     * with a message naming what to set.
     */
    const url = config.SUPABASE_URL?.replace(/\/+$/, '');
    const key = config.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
      throw new ApiError('AUTH_REQUIRED',
        'Sign-in is not configured on this server. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
    }
    let response: Response;
    try {
      response = await fetchImpl(`${url}/auth/v1/user`, {
        headers: { ...supabaseHeaders(key), authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The provider being unreachable is not permission to proceed.
      throw new ApiError('AUTH_REQUIRED', 'Could not verify the sign-in. Try again.');
    }
    if (!response.ok) {
      // Never surface the provider body: it echoes the token on some errors.
      throw new ApiError('AUTH_REQUIRED', 'That sign-in is not valid. Sign in again.');
    }

    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ApiError('AUTH_REQUIRED', 'Could not verify the sign-in. Try again.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ApiError('AUTH_REQUIRED', 'Could not verify the sign-in. Try again.');
    }
    const user = payload as SupabaseUser;

    const id = typeof user.id === 'string' ? user.id : '';
    const email = typeof user.email === 'string' ? user.email.trim() : '';
    // A verified session must have both. Supabase can return a user with no
    // email for provider types we do not enable; refusing is safer than
    // inventing an identity that invitations could never match.
    if (!UUID.test(id) || email.length < 3 || email.length > 320 || !email.includes('@')) {
      throw new ApiError('AUTH_REQUIRED', 'That account is missing a verified email address.');
    }
    return { supabaseUserId: id.toLowerCase(), email, displayName: safeDisplayName(user, email) };
  };
}
