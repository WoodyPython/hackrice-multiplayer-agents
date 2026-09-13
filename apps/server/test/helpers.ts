import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from 'dotenv';
import { createDb, type Db, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
config({ quiet: true });

/**
 * Tests run against a real Postgres, not a mock.
 *
 * Every rule this suite checks is enforced by the database (partial unique
 * indexes, composite foreign keys, check constraints). A mock would assert that
 * the mock works. The whole point of B01 is that these rules hold even when a
 * future service method forgets to check them.
 */

/** Tests default to local Docker regardless of the development/hosted database. */
export function testDatabaseUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://app:app@localhost:54322/app_test');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+_test$/.test(name)) throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test.');
  return url.toString();
}

/** Drops and recreates the test database, then migrates it from scratch. */
export async function resetTestDatabase(): Promise<void> {
  const target = new URL(testDatabaseUrl());
  const dbName = target.pathname.replace(/^\//, '');

  const admin = new URL(testDatabaseUrl());
  admin.pathname = '/postgres';

  const pool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
  try {
    // Terminate leftover connections from a previous crashed run, or DROP hangs.
    await pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [dbName],
    );
    await pool.query(`drop database if exists ${quoteIdent(dbName)}`);
    await pool.query(`create database ${quoteIdent(dbName)}`);
  } finally {
    await pool.end();
  }

  await runMigrations(testDatabaseUrl());
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function connectTestDb(): DbHandle {
  return createDb(testDatabaseUrl(), { max: 5 });
}

// --- fixtures --------------------------------------------------------------

export const BOOT_ID = randomUUID();

/** 40-char hex, deterministic per label, for SHA-shaped columns. */
export function fakeSha(label: string): string {
  let out = '';
  for (let i = 0; out.length < 40; i += 1) {
    out += Buffer.from(`${label}:${i}`).toString('hex');
  }
  return out.slice(0, 40);
}

/**
 * The account every suite acts as, unless it says otherwise.
 *
 * Authorization is now in front of every workspace route, so a fixture
 * workspace with no members would make 177 existing assertions fail on a 401
 * that has nothing to do with what they are testing. Those suites cover task,
 * Git and review behaviour; `permissions.test.ts` is what covers the gate, and
 * it deliberately builds its own callers instead of using these.
 */
export const TEST_USER_ID = '00000000-0000-4000-8000-00000000a001';
export const TEST_USER_EMAIL = 'owner@example.test';
/** A fixed, obviously-fake token. Real ones are 32 random bytes. */
export const TEST_SESSION_TOKEN = 'test-session-token-not-a-real-credential';

export function sessionCookie(token = TEST_SESSION_TOKEN): { cookie: string } {
  return { cookie: `coflow_session=${token}` };
}

/** Idempotent: suites create many workspaces against the same account. */
export async function ensureTestUser(db: Db): Promise<string> {
  await db.insertInto('users').values({
    id: TEST_USER_ID, supabase_user_id: TEST_USER_ID,
    email: TEST_USER_EMAIL, display_name: 'Test Owner',
  }).onConflict((oc) => oc.column('id').doNothing()).execute();
  await db.insertInto('sessions').values({
    user_id: TEST_USER_ID,
    token_hash: createHash('sha256').update(TEST_SESSION_TOKEN, 'utf8').digest(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
  }).onConflict((oc) => oc.column('token_hash').doNothing()).execute();
  return TEST_USER_ID;
}

/**
 * A second account with a chosen role, for tests that need a caller who is not
 * the fixture owner. Returns the cookie header to pass to `inject`.
 */
export async function signInAs(
  db: Db, options: { workspaceId?: string; role?: 'owner' | 'member'; label?: string } = {},
): Promise<{ cookie: string; userId: string }> {
  const label = options.label ?? 'member';
  const userId = randomUUID();
  const token = `test-session-${label}-${userId}`;
  await db.insertInto('users').values({
    id: userId, supabase_user_id: randomUUID(),
    email: `${label}-${userId}@example.test`, display_name: label,
  }).execute();
  await db.insertInto('sessions').values({
    user_id: userId,
    token_hash: createHash('sha256').update(token, 'utf8').digest(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
  }).execute();
  if (options.workspaceId && options.role) {
    await db.insertInto('workspace_members')
      .values({ workspace_id: options.workspaceId, user_id: userId, role: options.role })
      .execute();
  }
  return { cookie: `coflow_session=${token}`, userId };
}

export async function insertWorkspace(db: Db, name = 'Test workspace'): Promise<string> {
  await ensureTestUser(db);
  const row = await db
    .insertInto('workspaces')
    // Keeps the legacy hash so the claim tests have something to claim; a
    // workspace created through the API by an account has none.
    .values({ name, owner_key_hash: Buffer.alloc(32, 1) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.insertInto('workspace_members')
    .values({ workspace_id: row.id, user_id: TEST_USER_ID, role: 'owner' })
    .execute();
  return row.id;
}

export async function insertTask(
  db: Db,
  workspaceId: string,
  overrides: Partial<{
    kind: 'agent_task' | 'manual_edit';
    manual_source_path: string | null;
    title: string;
    status:
      | 'posted'
      | 'planning'
      | 'working'
      | 'needs_input'
      | 'ready_for_review'
      | 'conflict'
      | 'incomplete'
      | 'interrupted'
      | 'canceled'
      | 'completed';
  }> = {},
): Promise<string> {
  const row = await db
    .insertInto('tasks')
    .values({
      workspace_id: workspaceId,
      kind: overrides.kind ?? 'agent_task',
      manual_source_path: overrides.manual_source_path ?? null,
      creator_guest_label: 'Guest Cedar',
      title: overrides.title ?? 'Test task',
      ...(overrides.status ? { status: overrides.status } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function insertRun(
  db: Db,
  workspaceId: string,
  taskId: string,
  overrides: Partial<{
    attempt: number;
    status: 'planning' | 'working' | 'needs_input' | 'completed' | 'incomplete' | 'interrupted' | 'canceled';
    client_request_id: string | null;
    discussion_cutoff_seq: number;
  }> = {},
): Promise<string> {
  const row = await db
    .insertInto('runs')
    .values({
      workspace_id: workspaceId,
      task_id: taskId,
      attempt: overrides.attempt ?? 1,
      task_version: 1,
      guidance_version: 1,
      discussion_cutoff_seq: overrides.discussion_cutoff_seq ?? 0,
      client_request_id: overrides.client_request_id ?? null,
      boot_id: BOOT_ID,
      ...(overrides.status ? { status: overrides.status } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function insertDiscussionEntry(
  db: Db,
  workspaceId: string,
  taskId: string,
  overrides: Partial<{
    seq: number;
    actor_type: 'guest' | 'agent' | 'system';
    guest_label: string | null;
    body: string;
    client_request_id: string | null;
  }> = {},
): Promise<string> {
  const actorType = overrides.actor_type ?? 'guest';
  const row = await db
    .insertInto('discussion_entries')
    .values({
      workspace_id: workspaceId,
      task_id: taskId,
      seq: overrides.seq ?? 1,
      actor_type: actorType,
      guest_label:
        overrides.guest_label !== undefined
          ? overrides.guest_label
          : actorType === 'guest'
            ? 'Guest Cedar'
            : null,
      body: overrides.body ?? 'hello',
      client_request_id: overrides.client_request_id ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function insertBudget(
  db: Db,
  workspaceId: string,
  taskId: string,
  agentKey: string,
  tokenBudget = 64_000,
): Promise<void> {
  await db
    .insertInto('task_agent_budgets')
    .values({
      workspace_id: workspaceId,
      task_id: taskId,
      agent_key: agentKey,
      token_budget: tokenBudget,
    })
    .execute();
}

export async function insertAgentInstance(
  db: Db,
  workspaceId: string,
  taskId: string,
  runId: string,
  overrides: Partial<{
    agent_key: string;
    assignment_key: string;
    preset: 'orchestrator' | 'analyst' | 'writer' | 'coder' | 'reviewer';
  }> = {},
): Promise<string> {
  const agentKey = overrides.agent_key ?? 'orchestrator';
  const row = await db
    .insertInto('agent_instances')
    .values({
      workspace_id: workspaceId,
      task_id: taskId,
      run_id: runId,
      agent_key: agentKey,
      assignment_key: overrides.assignment_key ?? agentKey,
      preset: overrides.preset ?? 'orchestrator',
      model_id: 'gemini-2.5-pro',
      boot_id: BOOT_ID,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Asserts that `fn` rejects with a Postgres error of the given code. */
export async function expectPgError(
  fn: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    if (e.code !== code) {
      throw new Error(
        `expected Postgres error ${code}, got ${e.code}: ${(error as Error).message}`,
      );
    }
    if (constraint !== undefined && e.constraint !== constraint) {
      throw new Error(
        `expected constraint ${constraint}, got ${e.constraint}`,
      );
    }
    return;
  }
  throw new Error(`expected Postgres error ${code}, but the statement succeeded`);
}

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';
