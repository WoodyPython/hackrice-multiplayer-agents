#!/usr/bin/env node
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { sql } from 'kysely';
import { createDb, type Db } from '../src/db/client.js';
import { defaultBlobStore } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';

/**
 * What is taking up room, and what can safely stop doing so.
 *
 *   npm run workspace:gc --workspace @app/server              # report only
 *   npm run workspace:gc --workspace @app/server -- --delete  # act on it
 *
 * Why this exists: a workspace is durable by design -- it is the whole point
 * that closing the tab loses nothing -- and until now nothing ever removed one.
 * On a free Supabase plan (500 MB database, 1 GB storage) an afternoon of
 * testing is cheap and a year of it is not, and the failure mode is not a
 * warning, it is writes starting to fail.
 *
 * **Nothing is deleted without --delete.** The default is a report, because the
 * decision about which workspaces are junk belongs to a person who knows what
 * the demo is, not to a heuristic in a script. What the heuristics do is sort
 * the list so that decision is quick.
 *
 * Categories, narrowest first:
 *
 *   `orphaned`  A pre-accounts workspace nobody claimed. It has an owner key
 *               hash and no members, which means the only thing that can ever
 *               administer it is a key in some browser's localStorage. Once it
 *               has been idle for the threshold, it is unreachable in practice.
 *   `empty`     No tasks and no materials. Someone pressed Create and stopped.
 *   `archived`  Deliberately put away, and untouched since well past the
 *               threshold. This is the only category a person chose.
 *
 * A workspace with members and content is never listed, at any age. Deciding
 * that somebody's work has expired is not a thing a garbage collector should do
 * on its own, and `--ids` is there for when a person has decided it.
 */

loadDotenv({ path: resolvePath(process.cwd(), '../../.env'), quiet: true });
loadDotenv({ quiet: true });

interface Options {
  apply: boolean;
  idleDays: number;
  archivedDays: number;
  ids: string[];
  categories: Set<Category>;
}

type Category = 'orphaned' | 'empty' | 'archived' | 'selected';

const ALL: Category[] = ['orphaned', 'empty', 'archived'];

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false, idleDays: 7, archivedDays: 30, ids: [],
    categories: new Set(ALL),
  };
  const only: Category[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = () => argv[++index] ?? '';
    if (arg === '--delete' || arg === '--apply') options.apply = true;
    else if (arg === '--idle-days') options.idleDays = Number(value());
    else if (arg === '--archived-days') options.archivedDays = Number(value());
    else if (arg === '--ids') options.ids = value().split(',').map((id) => id.trim()).filter(Boolean);
    else if (ALL.includes(arg.replace(/^--/, '') as Category)) only.push(arg.replace(/^--/, '') as Category);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}\n`); usage(); process.exit(2); }
  }
  if (only.length) options.categories = new Set(only);
  if (!Number.isFinite(options.idleDays) || !Number.isFinite(options.archivedDays)) {
    console.error('--idle-days and --archived-days take a number of days.');
    process.exit(2);
  }
  return options;
}

function usage(): void {
  console.log(`Usage: workspace-gc [options]

  --delete                 Actually delete. Without it, nothing is changed.
  --idle-days <n>          Idle threshold for orphaned/empty (default 7).
  --archived-days <n>      How long archived before collectable (default 30).
  --ids <a,b,c>            Delete these workspace IDs regardless of category.
  --orphaned --empty --archived
                           Restrict to these categories (default: all three).
`);
}

interface Candidate {
  id: string;
  name: string;
  category: Category;
  reason: string;
  lastActivityAt: Date;
  tasks: number;
  events: number;
  materials: number;
  materialBytes: number;
  members: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL, { max: 2 });
  const db = handle.db;

  try {
    await reportSize(db);

    const rows = await inventory(db);
    const idle = Date.now() - options.idleDays * 86_400_000;
    const archivedBefore = Date.now() - options.archivedDays * 86_400_000;
    const selected = new Set(options.ids.map((id) => id.toLowerCase()));

    const candidates: Candidate[] = [];
    for (const row of rows) {
      const activity = new Date(row.last_activity_at).getTime();
      const base = {
        id: row.id, name: row.name, lastActivityAt: new Date(row.last_activity_at),
        tasks: Number(row.tasks), events: Number(row.events),
        materials: Number(row.materials), materialBytes: Number(row.material_bytes),
        members: Number(row.members),
      };
      if (selected.has(row.id.toLowerCase())) {
        candidates.push({ ...base, category: 'selected', reason: 'named with --ids' });
        continue;
      }
      if (row.status === 'archived' && row.archived_at &&
          new Date(row.archived_at).getTime() < archivedBefore) {
        candidates.push({ ...base, category: 'archived',
          reason: `archived ${days(new Date(row.archived_at))} days ago` });
        continue;
      }
      if (row.status === 'archived') continue;
      // Unclaimed and memberless: the only credential that can administer this
      // is an owner key in some browser's storage. Nothing else can reach it.
      if (row.owner_key_hash !== null && Number(row.members) === 0 && activity < idle) {
        candidates.push({ ...base, category: 'orphaned',
          reason: `pre-accounts, unclaimed, idle ${days(new Date(row.last_activity_at))} days` });
        continue;
      }
      if (Number(row.tasks) === 0 && Number(row.materials) === 0 && activity < idle) {
        candidates.push({ ...base, category: 'empty',
          reason: `never used, idle ${days(new Date(row.last_activity_at))} days` });
      }
    }

    const wanted = candidates.filter(
      (item) => item.category === 'selected' || options.categories.has(item.category));

    report(rows.length, wanted);

    if (!options.apply) {
      console.log(wanted.length === 0
        ? '\nNothing to collect.'
        : `\nNothing was changed. Re-run with --delete to remove these ${wanted.length}.`);
    } else if (wanted.length > 0) {
      await collect(db, config, wanted);
    }

    await reportOrphanedRepositories(db, config.gitDataRoot, options.apply);
  } finally {
    await handle.close();
  }
}

/**
 * Everything the categories need, in one query.
 *
 * Correlated subqueries rather than joins: this runs over tens of workspaces on
 * a free-tier instance, and the readable version is the one somebody will still
 * be able to change in six months.
 */
async function inventory(db: Db) {
  return db.selectFrom('workspaces as w')
    .select((eb) => [
      'w.id', 'w.name', 'w.status', 'w.owner_key_hash', 'w.archived_at',
      'w.created_at', 'w.last_activity_at',
      eb.selectFrom('tasks as t').select(({ fn }) => fn.countAll<string>().as('n'))
        .whereRef('t.workspace_id', '=', 'w.id').as('tasks'),
      eb.selectFrom('task_events as e').select(({ fn }) => fn.countAll<string>().as('n'))
        .whereRef('e.workspace_id', '=', 'w.id').as('events'),
      eb.selectFrom('materials as m').select(({ fn }) => fn.countAll<string>().as('n'))
        .whereRef('m.workspace_id', '=', 'w.id').as('materials'),
      eb.selectFrom('materials as m').select(({ fn }) => fn.coalesce(fn.sum<string>('m.byte_size'), sql<string>`0`).as('n'))
        .whereRef('m.workspace_id', '=', 'w.id').as('material_bytes'),
      eb.selectFrom('workspace_members as wm').select(({ fn }) => fn.countAll<string>().as('n'))
        .whereRef('wm.workspace_id', '=', 'w.id').as('members'),
    ])
    .orderBy('w.last_activity_at', 'asc')
    .execute();
}

async function reportSize(db: Db): Promise<void> {
  const size = await sql<{ size: string; bytes: string }>`
    select pg_size_pretty(pg_database_size(current_database())) as size,
           pg_database_size(current_database())::text as bytes`.execute(db);
  const row = size.rows[0];
  if (!row) return;
  // The free plan's ceiling, stated so the number means something. Reading
  // "13 MB" tells you nothing without it.
  const used = Number(row.bytes) / (500 * 1024 * 1024);
  console.log(`Database: ${row.size} of the 500 MB free-plan limit (${(used * 100).toFixed(1)}%)\n`);
}

function report(total: number, candidates: Candidate[]): void {
  console.log(`${total} workspace(s); ${candidates.length} collectable.\n`);
  if (candidates.length === 0) return;
  console.table(candidates.map((item) => ({
    id: item.id,
    name: item.name.length > 28 ? `${item.name.slice(0, 27)}…` : item.name,
    why: item.reason,
    tasks: item.tasks,
    events: item.events,
    materials: item.materials === 0 ? '-' : `${item.materials} (${kb(item.materialBytes)})`,
    members: item.members,
  })));
}

/**
 * Delete, in the same order and by the same route the API uses.
 *
 * One statement per workspace rather than one `where id in (...)`: a failure
 * then names the workspace it failed on and the rest still go.
 */
async function collect(db: Db, config: ReturnType<typeof loadConfig>, candidates: Candidate[]): Promise<void> {
  const blobs = defaultBlobStore(config);
  let removed = 0;
  for (const candidate of candidates) {
    // Read the object keys first: after the rows go, nothing knows where the
    // bytes are and they are orphaned in the bucket rather than reclaimed.
    const objects = await db.selectFrom('materials').select('object_key')
      .where('workspace_id', '=', candidate.id).execute();
    try {
      await db.deleteFrom('workspaces').where('id', '=', candidate.id).execute();
    } catch (error) {
      console.error(`  failed  ${candidate.id} (${candidate.name}): ${(error as Error).message}`);
      continue;
    }
    removed++;
    for (const object of objects) {
      // A bucket failure must not undo a database deletion that has committed.
      await blobs.delete(object.object_key).catch((error: unknown) => {
        console.error(`  storage ${object.object_key}: ${(error as Error).message}`);
      });
    }
    await removeRepository(config.gitDataRoot, candidate.id);
    console.log(`  deleted ${candidate.id}  ${candidate.name}`);
  }
  console.log(`\nRemoved ${removed} workspace(s).`);
}

/**
 * Repositories with no workspace row.
 *
 * These accumulate from the paths that cannot be transactional: a lifecycle
 * hook that failed, a process killed between the commit and the unlink, or a
 * database restored from a backup taken before the repository was made. They
 * are pure waste -- nothing can reach a repository whose workspace is gone.
 */
async function reportOrphanedRepositories(db: Db, gitDataRoot: string, apply: boolean): Promise<void> {
  const repos = join(gitDataRoot, 'repos');
  const entries = await readdir(repos).catch(() => [] as string[]);
  const live = new Set((await db.selectFrom('workspaces').select('id').execute())
    .map((row) => row.id.toLowerCase()));
  const orphans: Array<{ name: string; bytes: number }> = [];
  for (const entry of entries) {
    const id = entry.replace(/\.git$/, '').toLowerCase();
    // Only ever consider `<uuid>.git`, never a stray file or an init staging
    // directory that a concurrent create is still using.
    if (!/^[0-9a-f-]{36}\.git$/i.test(entry) || live.has(id)) continue;
    const info = await stat(join(repos, entry)).catch(() => undefined);
    orphans.push({ name: entry, bytes: info?.size ?? 0 });
  }
  if (orphans.length === 0) return;
  console.log(`\n${orphans.length} repository directory(ies) with no workspace row:`);
  for (const orphan of orphans) console.log(`  ${orphan.name}`);
  if (!apply) {
    console.log('  (re-run with --delete to remove them)');
    return;
  }
  for (const orphan of orphans) {
    await rm(join(repos, orphan.name), { recursive: true, force: true });
    await rm(join(gitDataRoot, 'worktrees', orphan.name.replace(/\.git$/, '')),
      { recursive: true, force: true });
    console.log(`  removed ${orphan.name}`);
  }
}

async function removeRepository(gitDataRoot: string, workspaceId: string): Promise<void> {
  for (const target of [
    join(gitDataRoot, 'repos', `${workspaceId}.git`),
    join(gitDataRoot, 'worktrees', workspaceId),
  ]) {
    await rm(target, { recursive: true, force: true }).catch((error: unknown) => {
      console.error(`  disk    ${target}: ${(error as Error).message}`);
    });
  }
}

function days(from: Date): number {
  return Math.floor((Date.now() - from.getTime()) / 86_400_000);
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} kB`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
