#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Minimal forward-only migration runner.
 *
 * Deliberately plain SQL + a small runner rather than a migration framework:
 * db/migrations is the schema source of truth (section 15.1), it must run
 * identically against local docker Postgres and hosted Supabase, and the
 * Supabase CLI is not a dependency anyone on the team needs to install.
 *
 * Three properties that matter for a four-person team sharing a database:
 *
 *  1. Advisory lock. Two people running `npm run db:migrate` at once serialize
 *     instead of both trying to CREATE TYPE.
 *  2. Checksums. If an already-applied file is edited, the run aborts instead
 *     of silently leaving one machine's schema different from another's. Fix
 *     forward with a new file.
 *  3. Per-file transaction. A failing file leaves nothing half-applied.
 */

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../db/migrations',
);

/** Arbitrary but fixed; any concurrent runner picks the same key. */
const ADVISORY_LOCK_KEY = 8_421_337;

interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      return {
        filename,
        sql,
        // Normalize line endings so a Windows checkout and a Linux CI runner
        // agree on the checksum.
        checksum: createHash('sha256')
          .update(sql.replace(/\r\n/g, '\n'))
          .digest('hex'),
      };
    });
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function appliedMigrations(
  client: pg.PoolClient,
): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    'select filename, checksum from schema_migrations',
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function up(client: pg.PoolClient): Promise<void> {
  await ensureMigrationsTable(client);
  const applied = await appliedMigrations(client);
  const files = loadMigrations();

  const drifted = files.filter(
    (f) => applied.has(f.filename) && applied.get(f.filename) !== f.checksum,
  );
  if (drifted.length > 0) {
    throw new Error(
      `Already-applied migrations were edited: ${drifted
        .map((f) => f.filename)
        .join(', ')}\n` +
        'Migrations are immutable once applied. Add a new numbered file instead.\n' +
        'To start over locally: npm run db:reset && npm run db:migrate',
    );
  }

  const pending = files.filter((f) => !applied.has(f.filename));
  if (pending.length === 0) {
    console.log(`Up to date (${files.length} migrations applied).`);
    return;
  }

  for (const file of pending) {
    process.stdout.write(`  applying ${file.filename} ... `);
    try {
      await client.query('begin');
      await client.query(file.sql);
      await client.query(
        'insert into schema_migrations (filename, checksum) values ($1, $2)',
        [file.filename, file.checksum],
      );
      await client.query('commit');
      console.log('ok');
    } catch (error) {
      await client.query('rollback');
      console.log('FAILED');
      throw error;
    }
  }
  console.log(`Applied ${pending.length} migration(s).`);
}

async function status(client: pg.PoolClient): Promise<void> {
  await ensureMigrationsTable(client);
  const applied = await appliedMigrations(client);
  for (const file of loadMigrations()) {
    const state = !applied.has(file.filename)
      ? 'pending'
      : applied.get(file.filename) === file.checksum
        ? 'applied'
        : 'DRIFTED';
    console.log(`  ${state.padEnd(8)} ${file.filename}`);
  }
}

/**
 * Runs every pending migration against `connectionString`.
 * Exported so tests can build a fresh schema without shelling out.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    ...(/@(localhost|127\.0\.0\.1|host\.docker\.internal|db)[:/]/.test(connectionString)
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  });
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await up(client);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const { config } = await import('dotenv');
  config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
  config({ quiet: true });

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root.',
    );
    process.exit(1);
  }

  const command = process.argv[2] ?? 'up';
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    ...(/@(localhost|127\.0\.0\.1|host\.docker\.internal|db)[:/]/.test(connectionString)
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  });
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    if (command === 'up') {
      await up(client);
    } else if (command === 'status') {
      await status(client);
    } else {
      console.error(`Unknown command: ${command}. Use "up" or "status".`);
      process.exitCode = 1;
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    client.release();
    await pool.end();
  }
}

// Only run the CLI when invoked directly, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
