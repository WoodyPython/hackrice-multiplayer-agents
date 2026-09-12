import { randomUUID } from 'node:crypto';
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

const DEFAULT_LOCAL = 'postgresql://app:app@localhost:54322/app';

function baseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_LOCAL;
}

/** Derives the test database URL, defaulting to `<db>_test`. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(baseUrl());
  url.pathname = `${url.pathname.replace(/^\//, '')}_test`;
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

export async function insertWorkspace(db: Db, name = 'Test workspace'): Promise<string> {
  const row = await db
    .insertInto('workspaces')
    .values({ name, owner_key_hash: Buffer.alloc(32, 1) })
    .returning('id')
    .executeTakeFirstOrThrow();
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
