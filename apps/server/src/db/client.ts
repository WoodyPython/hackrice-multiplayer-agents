import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

const { Pool, types } = pg;

/**
 * node-postgres returns int8 (bigint) as a string to avoid silent precision
 * loss past 2^53. None of our bigint columns can get near that: discussion
 * sequences, document revisions, token counts, and event IDs are all bounded by
 * human and model activity inside one hackathon workspace.
 *
 * Parsing them as numbers keeps every downstream comparison (cutoff checks,
 * revision guards, budget arithmetic) plain numeric instead of string-vs-number,
 * which is exactly the kind of mismatch that silently breaks a `>` comparison.
 */
types.setTypeParser(types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

/** numeric/decimal is not used by this schema; leave its default string parser. */

export type Db = Kysely<Database>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, options?: { max?: number }): DbHandle {
  const pool = new Pool({
    connectionString,
    max: options?.max ?? 10,
    // Supabase's pooler terminates idle connections; fail fast rather than
    // hanging a request on a dead socket.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Hosted Supabase requires TLS. Local docker does not offer it.
    ...(isLocal(connectionString) ? {} : { ssl: { rejectUnauthorized: false } }),
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    db,
    pool,
    async close() {
      await db.destroy();
    },
  };
}

function isLocal(connectionString: string): boolean {
  return /@(localhost|127\.0\.0\.1|host\.docker\.internal|db)[:/]/.test(connectionString);
}

/**
 * PostgreSQL error codes this codebase maps to specific API errors.
 * Services translate these rather than doing a racy SELECT-then-INSERT.
 */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  EXCLUSION_VIOLATION: '23P01',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

export interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

export function isPgError(error: unknown): error is PgError {
  return error instanceof Error && typeof (error as PgError).code === 'string';
}

/**
 * True when `error` is a unique violation on the named constraint or index.
 * Use this to turn a database rule into its API error, e.g.
 *   runs_active_uq              -> TASK_ALREADY_RUNNING
 *   runs_client_request_uq      -> idempotent replay, refetch the original
 *   tasks_manual_active_uq      -> reuse the existing editing task
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!isPgError(error) || error.code !== PG_ERROR.UNIQUE_VIOLATION) return false;
  return constraint === undefined || error.constraint === constraint;
}
