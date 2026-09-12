import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The owner key (design sections 1.2 and 12.2).
 *
 * This is the only person-related privilege distinction in the MVP. It is not
 * an account system: ownership is possession of the key, there is no recovery
 * flow, and copying the key transfers control.
 */

/** 32 random bytes, base64url-encoded to 43 URL-safe characters. */
export function generateOwnerKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, deliberately, not bcrypt or argon2.
 *
 * A slow KDF defends a secret that a human chose and an attacker can guess.
 * This secret is 256 bits from the system CSPRNG: there is no dictionary to
 * run, and the work factor would buy nothing while adding a native dependency
 * and per-request latency to every owner operation.
 *
 * What does matter is constant-time comparison, which `ownerKeyMatches`
 * provides. A fast hash compared with `===` would leak the stored digest one
 * byte at a time.
 */
export function hashOwnerKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Constant-time comparison of a candidate key against a stored hash.
 *
 * Returns false for a missing key and for a wrong key alike, so a caller cannot
 * distinguish the two. Hashing first also means the comparison is always over
 * 32 bytes regardless of the candidate's length, so length itself leaks nothing.
 */
export function ownerKeyMatches(
  candidate: string | undefined | null,
  storedHash: Buffer | Uint8Array,
): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;

  const stored = Buffer.isBuffer(storedHash) ? storedHash : Buffer.from(storedHash);
  if (stored.length !== 32) return false;

  return timingSafeEqual(hashOwnerKey(candidate), stored);
}

/**
 * Pulls the key out of a header value.
 *
 * Fastify gives `string | string[] | undefined`. A repeated header is an array;
 * treat that as absent rather than picking one, since a caller sending two
 * different keys is not a case with a correct answer.
 */
export function readOwnerKeyHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
