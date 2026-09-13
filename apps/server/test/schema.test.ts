import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIVE_RUN_STATUSES,
  AGENT_STATUSES,
  RUN_STATUSES,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
} from '@app/contracts';
import type { Db, DbHandle } from '../src/db/client.js';
import {
  BOOT_ID,
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
  connectTestDb,
  expectPgError,
  fakeSha,
  insertAgentInstance,
  insertBudget,
  insertDiscussionEntry,
  insertRun,
  insertTask,
  insertWorkspace,
} from './helpers.js';

/**
 * B01 acceptance: every rule in design section 11.2 is enforced by the
 * database, so a service method that forgets to check it still cannot corrupt
 * the invariant.
 *
 * Each test attempts the violation and expects a specific Postgres error on a
 * specific named constraint. Naming the constraint matters: it is what service
 * code matches on to produce the right section 12.5 error code, so a rename
 * that would silently break that mapping fails here.
 */

let handle: DbHandle;
let db: Db;

beforeAll(async () => {
  handle = connectTestDb();
  db = handle.db;
});

afterAll(async () => {
  await handle?.close();
});

describe('migrations', () => {
  it('creates every table in the contract', async () => {
    const rows = await db
      .selectFrom('schema_migrations')
      .select('filename')
      .orderBy('filename')
      .execute();
    expect(rows.map((r) => r.filename)).toEqual([
      '0001_enums.sql',
      '0002_tables.sql',
      '0003_indexes.sql',
      '0004_rls.sql',
      '0005_task_idempotency.sql',
      '0006_agent_write_guard.sql',
      '0007_stale_building_reviews.sql',
      '0008_security_hardening.sql',
      '0009_task_confirmation.sql',
      '0010_confirmation_file_ownership.sql',
    ]);
  });

  it('enables row level security on every application table', async () => {
    const { rows } = await handle.pool.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
       where schemaname = 'public'`,
    );
    const unprotected = rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
    expect(unprotected).toEqual([]);
    expect(rows.length).toBe(18);
  });

  it('pins the agent write guard search path', async () => {
    const { rows } = await handle.pool.query(
      "select proconfig from pg_proc where oid = 'public.agent_instances_guard_writes()'::regprocedure",
    );
    expect(rows[0].proconfig).toContain('search_path=public, pg_temp');
  });

  it('defines no RLS policies, so PostgREST denies everything', async () => {
    // Section 11.4: browsers never touch tables directly. RLS on with zero
    // policies is deny-all for anon/authenticated; the API connects as owner.
    const { rows } = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from pg_policies where schemaname = 'public'`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('enum parity with @app/contracts', () => {
  it('task_status matches TASK_STATUSES exactly', async () => {
    expect(await enumValues('task_status')).toEqual([...TASK_STATUSES]);
  });

  it('agent_status matches AGENT_STATUSES exactly', async () => {
    expect(await enumValues('agent_status')).toEqual([...AGENT_STATUSES]);
  });

  async function enumValues(typeName: string): Promise<string[]> {
    const { rows } = await handle.pool.query<{ label: string }>(
      `select e.enumlabel as label
         from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = $1
        order by e.enumsortorder`,
      [typeName],
    );
    return rows.map((r) => r.label);
  }
});

describe('partial index predicates match the contracts package', () => {
  /*
   * These sets exist twice by necessity: once in a SQL index predicate, once as
   * a TypeScript constant queries are built from. SQL cannot import the
   * constant, so divergence is silent and dangerous — a status added to the
   * enum but missing from runs_active_uq would let two runs be active at once,
   * which is the single invariant the duplicate-Start guard rests on.
   */
  async function indexPredicate(indexName: string): Promise<string> {
    const { rows } = await handle.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = $1`,
      [indexName],
    );
    const def = rows[0]?.indexdef;
    if (!def) throw new Error(`no index named ${indexName}`);
    return def;
  }

  it('runs_active_uq covers exactly ACTIVE_RUN_STATUSES', async () => {
    const def = await indexPredicate('runs_active_uq');
    for (const status of ACTIVE_RUN_STATUSES) {
      expect(def, `runs_active_uq is missing ${status}`).toContain(status);
    }
    // And nothing beyond them: every other run status must be absent.
    const extra = RUN_STATUSES.filter(
      (s) => !(ACTIVE_RUN_STATUSES as readonly string[]).includes(s),
    );
    for (const status of extra) {
      expect(def, `runs_active_uq unexpectedly covers ${status}`).not.toContain(status);
    }
  });

  it('tasks_manual_active_uq releases canceled and applied tasks', async () => {
    const def = await indexPredicate('tasks_manual_active_uq');
    for (const status of [...TERMINAL_TASK_STATUSES, 'awaiting_confirmation']) {
      expect(def, `tasks_manual_active_uq is missing ${status}`).toContain(status);
    }
  });
});

describe('workspace scoping', () => {
  it('rejects attaching workspace A material to a workspace B task', async () => {
    const wsA = await insertWorkspace(db, 'A');
    const wsB = await insertWorkspace(db, 'B');
    const taskB = await insertTask(db, wsB);

    const material = await db
      .insertInto('materials')
      .values({
        workspace_id: wsA,
        filename: 'brief.md',
        object_key: `ws/${wsA}/${randomUUID()}`,
        sha256: Buffer.alloc(32, 7),
        byte_size: 10,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // The composite FK carries workspace_id, so this is impossible at the
    // database level rather than by application convention.
    await expectPgError(
      () =>
        db
          .insertInto('material_links')
          .values({
            workspace_id: wsB,
            material_id: material.id,
            task_id: taskB,
          })
          .execute(),
      FOREIGN_KEY_VIOLATION,
      'material_links_material_fk',
    );
  });

  it('rejects a discussion entry claiming the wrong workspace', async () => {
    const wsA = await insertWorkspace(db, 'A');
    const wsB = await insertWorkspace(db, 'B');
    const taskA = await insertTask(db, wsA);

    await expectPgError(
      () =>
        db
          .insertInto('discussion_entries')
          .values({
            workspace_id: wsB,
            task_id: taskA,
            seq: 1,
            actor_type: 'guest',
            guest_label: 'Guest Cedar',
            body: 'hi',
          })
          .execute(),
      FOREIGN_KEY_VIOLATION,
      'discussion_entries_task_fk',
    );
  });
});

describe('unique active run per task', () => {
  it('rejects a second active run', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await insertRun(db, ws, task, { attempt: 1, status: 'planning' });

    await expectPgError(
      () => insertRun(db, ws, task, { attempt: 2, status: 'working' }),
      UNIQUE_VIOLATION,
      'runs_active_uq',
    );
  });

  it('allows a new attempt once the previous run is terminal', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await insertRun(db, ws, task, { attempt: 1, status: 'canceled' });
    const second = await insertRun(db, ws, task, { attempt: 2, status: 'planning' });
    expect(second).toBeTruthy();
  });

  it('treats needs_input as active, so a waiting run blocks a new start', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await insertRun(db, ws, task, { attempt: 1, status: 'needs_input' });
    await expectPgError(
      () => insertRun(db, ws, task, { attempt: 2, status: 'planning' }),
      UNIQUE_VIOLATION,
      'runs_active_uq',
    );
  });

  it('scopes the active-run rule per task, not per workspace', async () => {
    const ws = await insertWorkspace(db);
    const taskA = await insertTask(db, ws, { title: 'A' });
    const taskB = await insertTask(db, ws, { title: 'B' });
    await insertRun(db, ws, taskA, { status: 'working' });
    const other = await insertRun(db, ws, taskB, { status: 'working' });
    expect(other).toBeTruthy();
  });
});

describe('start idempotency', () => {
  it('rejects a replayed clientRequestId on the same task', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await insertRun(db, ws, task, {
      attempt: 1,
      status: 'completed',
      client_request_id: 'req-1',
    });

    await expectPgError(
      () =>
        insertRun(db, ws, task, {
          attempt: 2,
          status: 'planning',
          client_request_id: 'req-1',
        }),
      UNIQUE_VIOLATION,
      'runs_client_request_uq',
    );
  });

  it('scopes the key per task, so the same string on another task is fine', async () => {
    const ws = await insertWorkspace(db);
    const taskA = await insertTask(db, ws, { title: 'A' });
    const taskB = await insertTask(db, ws, { title: 'B' });
    await insertRun(db, ws, taskA, { status: 'working', client_request_id: 'shared' });
    const other = await insertRun(db, ws, taskB, {
      status: 'working',
      client_request_id: 'shared',
    });
    expect(other).toBeTruthy();
  });
});

describe('tasks.active_run_id', () => {
  it('cannot point at a run belonging to a different task', async () => {
    const ws = await insertWorkspace(db);
    const taskA = await insertTask(db, ws, { title: 'A' });
    const taskB = await insertTask(db, ws, { title: 'B' });
    const runB = await insertRun(db, ws, taskB, { status: 'working' });

    await expectPgError(
      () =>
        db
          .updateTable('tasks')
          .set({ active_run_id: runB })
          .where('id', '=', taskA)
          .execute(),
      FOREIGN_KEY_VIOLATION,
      'tasks_active_run_fk',
    );
  });

  it('accepts a run of the same task', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const run = await insertRun(db, ws, task, { status: 'planning' });
    await db.updateTable('tasks').set({ active_run_id: run }).where('id', '=', task).execute();
    const row = await db
      .selectFrom('tasks')
      .select('active_run_id')
      .where('id', '=', task)
      .executeTakeFirstOrThrow();
    expect(row.active_run_id).toBe(run);
  });
});

describe('discussion', () => {
  it('rejects a duplicate seq within a task', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await insertDiscussionEntry(db, ws, task, { seq: 1 });
    await expectPgError(
      () => insertDiscussionEntry(db, ws, task, { seq: 1 }),
      UNIQUE_VIOLATION,
      'discussion_entries_seq_uq',
    );
  });

  it('rejects a replayed clientRequestId', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await insertDiscussionEntry(db, ws, task, { seq: 1, client_request_id: 'c1' });
    await expectPgError(
      () => insertDiscussionEntry(db, ws, task, { seq: 2, client_request_id: 'c1' }),
      UNIQUE_VIOLATION,
      'discussion_entries_client_request_uq',
    );
  });

  it('requires a guest label on guest entries and forbids one elsewhere', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);

    await expectPgError(
      () => insertDiscussionEntry(db, ws, task, { seq: 1, actor_type: 'guest', guest_label: null }),
      CHECK_VIOLATION,
      'discussion_entries_guest_label_ck',
    );

    await expectPgError(
      () =>
        insertDiscussionEntry(db, ws, task, {
          seq: 2,
          actor_type: 'agent',
          guest_label: 'Guest Cedar',
        }),
      CHECK_VIOLATION,
      'discussion_entries_guest_label_ck',
    );
  });

  it('allocates gap-free sequence numbers under the task row lock', async () => {
    // This is the mechanism behind an exact run cutoff (section 2.3): the
    // UPDATE ... RETURNING serializes allocation on the task row, so sequence
    // order equals commit order.
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);

    const allocate = async (): Promise<number> =>
      db.transaction().execute(async (trx) => {
        const { discussion_seq } = await trx
          .updateTable('tasks')
          .set((eb) => ({ discussion_seq: eb('discussion_seq', '+', 1) }))
          .where('id', '=', task)
          .returning('discussion_seq')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('discussion_entries')
          .values({
            workspace_id: ws,
            task_id: task,
            seq: discussion_seq,
            actor_type: 'guest',
            guest_label: 'Guest Cedar',
            body: `entry ${discussion_seq}`,
          })
          .execute();
        return discussion_seq;
      });

    const seqs = await Promise.all(Array.from({ length: 12 }, allocate));
    expect([...seqs].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});

describe('manual-edit task uniqueness', () => {
  it('rejects a second active editing task for the same file', async () => {
    const ws = await insertWorkspace(db);
    await insertTask(db, ws, { kind: 'manual_edit', manual_source_path: 'documents/faq.md' });
    await expectPgError(
      () =>
        insertTask(db, ws, { kind: 'manual_edit', manual_source_path: 'documents/faq.md' }),
      UNIQUE_VIOLATION,
      'tasks_manual_active_uq',
    );
  });

  it.each([...TERMINAL_TASK_STATUSES, 'awaiting_confirmation'] as const)(
    'allows a new editing task once the previous one is %s',
    async (status) => {
      const ws = await insertWorkspace(db);
      const first = await insertTask(db, ws, {
        kind: 'manual_edit',
        manual_source_path: 'documents/notes.md',
      });
      await db.updateTable('tasks').set({ status }).where('id', '=', first).execute();
      const second = await insertTask(db, ws, {
        kind: 'manual_edit',
        manual_source_path: 'documents/notes.md',
      });
      expect(second).toBeTruthy();
    },
  );

  it('keeps the file owned while the task is incomplete or interrupted', async () => {
    // Section 2.4 offers manual retry from both, so a second editor on the same
    // path would fork the draft behind the user's back.
    for (const status of ['incomplete', 'interrupted'] as const) {
      const ws = await insertWorkspace(db);
      const first = await insertTask(db, ws, {
        kind: 'manual_edit',
        manual_source_path: 'documents/spec.md',
      });
      await db.updateTable('tasks').set({ status }).where('id', '=', first).execute();
      await expectPgError(
        () =>
          insertTask(db, ws, {
            kind: 'manual_edit',
            manual_source_path: 'documents/spec.md',
          }),
        UNIQUE_VIOLATION,
        'tasks_manual_active_uq',
      );
    }
  });

  it('requires manual_source_path exactly for manual_edit tasks', async () => {
    const ws = await insertWorkspace(db);
    await expectPgError(
      () => insertTask(db, ws, { kind: 'manual_edit', manual_source_path: null }),
      CHECK_VIOLATION,
      'tasks_manual_path_ck',
    );
    await expectPgError(
      () => insertTask(db, ws, { kind: 'agent_task', manual_source_path: 'documents/x.md' }),
      CHECK_VIOLATION,
      'tasks_manual_path_ck',
    );
  });
});

describe('draft documents', () => {
  it('allows one active document per task and path', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await db
      .insertInto('draft_files')
      .values({ workspace_id: ws, task_id: task, path: 'documents/faq.md' })
      .execute();

    await expectPgError(
      () =>
        db
          .insertInto('draft_files')
          .values({ workspace_id: ws, task_id: task, path: 'documents/faq.md', epoch: 2 })
          .execute(),
      UNIQUE_VIOLATION,
      'draft_files_active_uq',
    );
  });

  it('keeps a closed epoch as history while a new one opens', async () => {
    // Section 7.6: bumping an epoch creates a new row; the old one is never
    // overwritten and its ID stays resolvable for late-edit recovery.
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const first = await db
      .insertInto('draft_files')
      .values({ workspace_id: ws, task_id: task, path: 'documents/faq.md' })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db.updateTable('draft_files').set({ status: 'closed' }).where('id', '=', first.id).execute();

    const second = await db
      .insertInto('draft_files')
      .values({ workspace_id: ws, task_id: task, path: 'documents/faq.md', epoch: 2 })
      .returning('id')
      .executeTakeFirstOrThrow();

    const rows = await db
      .selectFrom('draft_files')
      .select(['id', 'epoch', 'status'])
      .where('task_id', '=', task)
      .orderBy('epoch')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.id).toBe(second.id);
  });
});

describe('agent graph', () => {
  it('rejects a dependency on itself', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const run = await insertRun(db, ws, task, { status: 'planning' });
    await insertBudget(db, ws, task, 'faq');
    const agent = await insertAgentInstance(db, ws, task, run, {
      agent_key: 'faq',
      assignment_key: 'faq',
      preset: 'writer',
    });

    await expectPgError(
      () =>
        db
          .insertInto('agent_dependencies')
          .values({ run_id: run, agent_id: agent, prerequisite_agent_id: agent })
          .execute(),
      CHECK_VIOLATION,
      'agent_dependencies_no_self_ck',
    );
  });

  it('rejects a dependency that crosses runs', async () => {
    const ws = await insertWorkspace(db);
    const taskA = await insertTask(db, ws, { title: 'A' });
    const taskB = await insertTask(db, ws, { title: 'B' });
    const runA = await insertRun(db, ws, taskA, { status: 'planning' });
    const runB = await insertRun(db, ws, taskB, { status: 'planning' });
    await insertBudget(db, ws, taskA, 'a');
    await insertBudget(db, ws, taskB, 'b');
    const agentA = await insertAgentInstance(db, ws, taskA, runA, { agent_key: 'a', assignment_key: 'a' });
    const agentB = await insertAgentInstance(db, ws, taskB, runB, { agent_key: 'b', assignment_key: 'b' });

    await expectPgError(
      () =>
        db
          .insertInto('agent_dependencies')
          .values({ run_id: runA, agent_id: agentA, prerequisite_agent_id: agentB })
          .execute(),
      FOREIGN_KEY_VIOLATION,
      'agent_dependencies_prereq_fk',
    );
  });

  it('rejects a duplicate assignment key within one run', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const run = await insertRun(db, ws, task, { status: 'planning' });
    await insertBudget(db, ws, task, 'writer-1');
    await insertAgentInstance(db, ws, task, run, { agent_key: 'writer-1', assignment_key: 'faq' });

    await insertBudget(db, ws, task, 'writer-2');
    await expectPgError(
      () =>
        insertAgentInstance(db, ws, task, run, {
          agent_key: 'writer-2',
          assignment_key: 'faq',
        }),
      UNIQUE_VIOLATION,
      'agent_instances_assignment_uq',
    );
  });

  it('requires a budget row before an instance can exist', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const run = await insertRun(db, ws, task, { status: 'planning' });
    await expectPgError(
      () => insertAgentInstance(db, ws, task, run, { agent_key: 'no-budget' }),
      FOREIGN_KEY_VIOLATION,
      'agent_instances_budget_fk',
    );
  });

  it('keeps the budget when a retry creates a new instance', async () => {
    // Section 14.3: "reusing the same task-and-agent budget rows and
    // accumulated usage. An exhausted budget remains exhausted on retry."
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await insertBudget(db, ws, task, 'faq');
    await db
      .updateTable('task_agent_budgets')
      .set({ consumed_tokens: 64_000 })
      .where('task_id', '=', task)
      .where('agent_key', '=', 'faq')
      .execute();

    const run1 = await insertRun(db, ws, task, { attempt: 1, status: 'incomplete' });
    await insertAgentInstance(db, ws, task, run1, { agent_key: 'faq', assignment_key: 'faq' });
    const run2 = await insertRun(db, ws, task, { attempt: 2, status: 'planning' });
    await insertAgentInstance(db, ws, task, run2, { agent_key: 'faq', assignment_key: 'faq' });

    const budget = await db
      .selectFrom('task_agent_budgets')
      .selectAll()
      .where('task_id', '=', task)
      .where('agent_key', '=', 'faq')
      .executeTakeFirstOrThrow();
    expect(budget.consumed_tokens).toBe(64_000);
  });

  it('gives the same agent an independent budget on another task', async () => {
    const ws = await insertWorkspace(db);
    const taskA = await insertTask(db, ws, { title: 'A' });
    const taskB = await insertTask(db, ws, { title: 'B' });
    await insertBudget(db, ws, taskA, 'faq');
    await insertBudget(db, ws, taskB, 'faq');
    await db
      .updateTable('task_agent_budgets')
      .set({ consumed_tokens: 64_000 })
      .where('task_id', '=', taskA)
      .execute();

    const b = await db
      .selectFrom('task_agent_budgets')
      .select('consumed_tokens')
      .where('task_id', '=', taskB)
      .executeTakeFirstOrThrow();
    expect(b.consumed_tokens).toBe(0);
  });

  it('pairs started_at with deadline_at', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const run = await insertRun(db, ws, task, { status: 'planning' });
    await insertBudget(db, ws, task, 'k');
    const agent = await insertAgentInstance(db, ws, task, run, { agent_key: 'k' });

    await expectPgError(
      () =>
        db
          .updateTable('agent_instances')
          .set({ started_at: new Date() })
          .where('id', '=', agent)
          .execute(),
      CHECK_VIOLATION,
      'agent_instances_deadline_ck',
    );
  });
});

describe('agent questions', () => {
  async function questionFixture() {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const run = await insertRun(db, ws, task, { status: 'working' });
    await insertBudget(db, ws, task, 'analyst');
    const agent = await insertAgentInstance(db, ws, task, run, {
      agent_key: 'analyst',
      assignment_key: 'analyst',
      preset: 'analyst',
    });
    const entry = await insertDiscussionEntry(db, ws, task, {
      seq: 1,
      actor_type: 'agent',
      body: 'Which region does this launch cover?',
    });
    return { ws, task, run, agent, entry };
  }

  it('allows at most one open question per agent instance', async () => {
    const { ws, task, run, agent } = await questionFixture();
    const e1 = await insertDiscussionEntry(db, ws, task, { seq: 2, actor_type: 'agent', body: 'q1' });
    const e2 = await insertDiscussionEntry(db, ws, task, { seq: 3, actor_type: 'agent', body: 'q2' });

    const base = {
      workspace_id: ws,
      task_id: task,
      run_id: run,
      agent_instance_id: agent,
      expires_at: new Date(Date.now() + 600_000),
    };
    await db.insertInto('agent_questions').values({ ...base, question_entry_id: e1 }).execute();

    await expectPgError(
      () => db.insertInto('agent_questions').values({ ...base, question_entry_id: e2 }).execute(),
      UNIQUE_VIOLATION,
      'agent_questions_one_open_uq',
    );
  });

  it('allows a new question once the previous is answered', async () => {
    const { ws, task, run, agent, entry } = await questionFixture();
    const q = await db
      .insertInto('agent_questions')
      .values({
        workspace_id: ws,
        task_id: task,
        run_id: run,
        agent_instance_id: agent,
        question_entry_id: entry,
        expires_at: new Date(Date.now() + 600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const answer = await insertDiscussionEntry(db, ws, task, { seq: 2, body: 'EMEA only' });
    await db
      .updateTable('agent_questions')
      .set({ status: 'answered', answer_entry_id: answer, resolved_at: new Date() })
      .where('id', '=', q.id)
      .execute();

    const next = await insertDiscussionEntry(db, ws, task, { seq: 3, actor_type: 'agent', body: 'q2' });
    const second = await db
      .insertInto('agent_questions')
      .values({
        workspace_id: ws,
        task_id: task,
        run_id: run,
        agent_instance_id: agent,
        question_entry_id: next,
        expires_at: new Date(Date.now() + 600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(second.id).toBeTruthy();
  });

  it('requires an answer entry exactly when answered', async () => {
    const { ws, task, run, agent, entry } = await questionFixture();
    await expectPgError(
      () =>
        db
          .insertInto('agent_questions')
          .values({
            workspace_id: ws,
            task_id: task,
            run_id: run,
            agent_instance_id: agent,
            question_entry_id: entry,
            status: 'answered',
            expires_at: new Date(),
          })
          .execute(),
      CHECK_VIOLATION,
      'agent_questions_answered_ck',
    );
  });

  it('requires resolved_at exactly when not open', async () => {
    const { ws, task, run, agent, entry } = await questionFixture();
    await expectPgError(
      () =>
        db
          .insertInto('agent_questions')
          .values({
            workspace_id: ws,
            task_id: task,
            run_id: run,
            agent_instance_id: agent,
            question_entry_id: entry,
            status: 'expired',
            expires_at: new Date(),
          })
          .execute(),
      CHECK_VIOLATION,
      'agent_questions_resolved_ck',
    );
  });

  it('rejects a question entry from another task', async () => {
    const { ws, task, run, agent } = await questionFixture();
    const otherTask = await insertTask(db, ws, { title: 'Other' });
    const foreign = await insertDiscussionEntry(db, ws, otherTask, {
      seq: 1,
      actor_type: 'agent',
      body: 'q',
    });

    await expectPgError(
      () =>
        db
          .insertInto('agent_questions')
          .values({
            workspace_id: ws,
            task_id: task,
            run_id: run,
            agent_instance_id: agent,
            question_entry_id: foreign,
            expires_at: new Date(),
          })
          .execute(),
      FOREIGN_KEY_VIOLATION,
      'agent_questions_entry_fk',
    );
  });
});

describe('materials', () => {
  it('dedupes identical bytes within a workspace', async () => {
    const ws = await insertWorkspace(db);
    const sha = Buffer.alloc(32, 9);
    await db
      .insertInto('materials')
      .values({
        workspace_id: ws,
        filename: 'a.md',
        object_key: `ws/${ws}/${randomUUID()}`,
        sha256: sha,
        byte_size: 3,
      })
      .execute();

    await expectPgError(
      () =>
        db
          .insertInto('materials')
          .values({
            workspace_id: ws,
            filename: 'copy-of-a.md',
            object_key: `ws/${ws}/${randomUUID()}`,
            sha256: sha,
            byte_size: 3,
          })
          .execute(),
      UNIQUE_VIOLATION,
      'materials_content_uq',
    );
  });

  it('dedupes attachments including workspace-level links with null task', async () => {
    // NULLS NOT DISTINCT: without it, repeated workspace-level links would
    // insert unbounded duplicate rows.
    const ws = await insertWorkspace(db);
    const material = await db
      .insertInto('materials')
      .values({
        workspace_id: ws,
        filename: 'a.md',
        object_key: `ws/${ws}/${randomUUID()}`,
        sha256: Buffer.alloc(32, 4),
        byte_size: 3,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('material_links')
      .values({ workspace_id: ws, material_id: material.id })
      .execute();

    await expectPgError(
      () =>
        db
          .insertInto('material_links')
          .values({ workspace_id: ws, material_id: material.id })
          .execute(),
      UNIQUE_VIOLATION,
      'material_links_dedupe_uq',
    );
  });
});

describe('reviews and apply', () => {
  it('allows only one apply operation per review', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const review = await db
      .insertInto('reviews')
      .values({
        workspace_id: ws,
        task_id: task,
        task_version: 1,
        guidance_version: 1,
        main_sha: fakeSha('main'),
        human_sha: fakeSha('human'),
        context_hash: 'ctx',
        candidate_sha: fakeSha('cand'),
        status: 'ready',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const op = {
      workspace_id: ws,
      review_id: review.id,
      expected_main_sha: fakeSha('main'),
      candidate_sha: fakeSha('cand'),
      boot_id: BOOT_ID,
    };
    await db.insertInto('apply_operations').values(op).execute();
    await expectPgError(
      () => db.insertInto('apply_operations').values(op).execute(),
      UNIQUE_VIOLATION,
      'apply_operations_review_id_key',
    );
  });

  it('requires a candidate for any review past building', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await expectPgError(
      () =>
        db
          .insertInto('reviews')
          .values({
            workspace_id: ws,
            task_id: task,
            task_version: 1,
            guidance_version: 1,
            main_sha: fakeSha('main'),
            human_sha: fakeSha('human'),
            context_hash: 'ctx',
            status: 'ready',
          })
          .execute(),
      CHECK_VIOLATION,
      'reviews_candidate_ck',
    );
  });

  it('rejects a malformed SHA', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    await expectPgError(
      () =>
        db
          .insertInto('reviews')
          .values({
            workspace_id: ws,
            task_id: task,
            task_version: 1,
            guidance_version: 1,
            main_sha: 'abc123',
            human_sha: fakeSha('human'),
            context_hash: 'ctx',
            candidate_sha: fakeSha('c'),
            status: 'ready',
          })
          .execute(),
      CHECK_VIOLATION,
      'reviews_main_sha_check',
    );
  });
});

describe('task events', () => {
  it('makes a repeated append with the same key a no-op', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    const values = {
      workspace_id: ws,
      task_id: task,
      event_key: `task:${task}:posted`,
      type: 'task.posted',
    };

    await db.insertInto('task_events').values(values).execute();
    const result = await db
      .insertInto('task_events')
      .values(values)
      .onConflict((oc) => oc.columns(['task_id', 'event_key']).doNothing())
      .executeTakeFirst();
    expect(Number(result.numInsertedOrUpdatedRows ?? 0)).toBe(0);

    const rows = await db.selectFrom('task_events').selectAll().where('task_id', '=', task).execute();
    expect(rows).toHaveLength(1);
  });
});

describe('task status vocabulary', () => {
  it('accepts every status the contracts package declares', async () => {
    const ws = await insertWorkspace(db);
    const task = await insertTask(db, ws);
    for (const status of TASK_STATUSES) {
      await db.updateTable('tasks').set({ status }).where('id', '=', task).execute();
    }
    const row = await db
      .selectFrom('tasks')
      .select('status')
      .where('id', '=', task)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe(TASK_STATUSES[TASK_STATUSES.length - 1]);
  });
});
