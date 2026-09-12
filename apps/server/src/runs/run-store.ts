import {
  ApiError,
  type AgentInstance,
  type AgentPlan,
  type ContextManifest,
  type RunStatus,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { AgentInstanceRow, RunRow } from '../db/types.js';
import { appendEvent } from '../events/service.js';
import { toIsoOrNull } from '../http/serialize.js';

/**
 * B07: run-level metadata and scheduling shape (design sections 8.3, 14.4).
 *
 * Scope boundary with Role C, settled after C02 and B07 both shipped ledgers:
 *
 *   Agent instance lifecycle and token budgets belong to PgAgentLedger in
 *   src/agents. Section 15.1 assigns that directory to Role C, its reserve
 *   derives the output allowance from the remaining budget as section 9.3 step 3
 *   requires, and it owns the deadline sweep. There is one writer to
 *   task_agent_budgets and one path that creates an instance.
 *
 *   What stays here is the run: what it captured, when it ended, the dependency
 *   graph between its assignments, which of them are ready, and what a restart
 *   must clean up. None of that is per-agent execution.
 */

export interface RunStoreDeps {
  db: Db;
  bootId: string;
}

export class PgRunStore {
  constructor(private readonly deps: RunStoreDeps) {}

  // -------------------------------------------------------------------------
  // Run records
  // -------------------------------------------------------------------------

  /**
   * Records what the run captured (section 2.2 steps 4 to 6).
   *
   * Guarded on boot: a run from a previous process was marked interrupted at
   * startup, and a late capture must not resurrect it (section 14.4, "every
   * active write checks its run/boot identity").
   */
  async recordCapture(
    runId: string,
    input: { inputSnapshotSha: string; contextManifest: ContextManifest },
  ): Promise<void> {
    const updated = await this.deps.db
      .updateTable('runs')
      .set({
        input_snapshot_sha: input.inputSnapshotSha,
        context_manifest: input.contextManifest as unknown as Record<string, unknown>,
      })
      .where('id', '=', runId)
      .where('boot_id', '=', this.deps.bootId)
      .where('status', 'in', ['planning', 'working', 'needs_input'])
      .returning('id')
      .executeTakeFirst();

    if (!updated) throw this.staleRunError(runId);
  }

  async recordResultHead(runId: string, resultHeadSha: string): Promise<void> {
    const updated = await this.deps.db
      .updateTable('runs')
      .set({ result_head_sha: resultHeadSha })
      .where('id', '=', runId)
      .where('boot_id', '=', this.deps.bootId)
      .where('status', 'in', ['planning', 'working', 'needs_input'])
      .returning('id')
      .executeTakeFirst();

    if (!updated) throw this.staleRunError(runId);
  }

  /**
   * Moves a run to a terminal status and clears the task's active pointer.
   *
   * Clearing `active_run_id` is what frees the unique-active-run slot for a
   * retry. Leaving it set would make the task permanently unstartable while
   * reporting a run that is no longer doing anything.
   */
  async settle(
    runId: string,
    status: Extract<RunStatus, 'completed' | 'incomplete' | 'interrupted' | 'canceled'>,
    reason?: string,
  ): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      // Lock order is task, then run, matching src/agents and section 6.3.
      const run = await trx
        .selectFrom('runs')
        .selectAll()
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!run) throw new ApiError('RUN_NOT_FOUND', 'No such run.');

      await trx
        .selectFrom('tasks')
        .select('id')
        .where('id', '=', run.task_id)
        .forUpdate()
        .executeTakeFirst();

      const locked = await trx
        .selectFrom('runs')
        .selectAll()
        .where('id', '=', runId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!isActiveRun(locked.status)) return;

      const now = new Date();
      await trx
        .updateTable('runs')
        .set({ status, ended_at: now })
        .where('id', '=', runId)
        .execute();

      await trx
        .updateTable('tasks')
        .set({ active_run_id: null, updated_at: now })
        .where('id', '=', run.task_id)
        .where('active_run_id', '=', runId)
        .execute();

      // Section 2.6: resolve open questions so the task cannot report
      // needs_input with nothing left to answer.
      await trx
        .updateTable('agent_questions')
        .set({ status: 'canceled', resolved_at: now })
        .where('run_id', '=', runId)
        .where('status', '=', 'open')
        .execute();

      await appendEvent(trx, {
        workspaceId: run.workspace_id,
        taskId: run.task_id,
        runId,
        eventKey: `run:${runId}:${status}`,
        type: status === 'completed' ? 'agent.completed' : 'task.canceled',
        payload: reason ? { reason } : {},
      });
    });
  }

  async read(runId: string): Promise<RunRow | undefined> {
    return this.deps.db
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
  }

  // -------------------------------------------------------------------------
  // The assignment graph (section 8.3)
  // -------------------------------------------------------------------------

  /**
   * Writes the dependency edges for a plan whose instances already exist.
   *
   * Instances are created one at a time through the agent ledger, which is what
   * keeps budget creation and instance creation on a single path. The edges
   * between them are run metadata and belong here: both foreign keys carry
   * `run_id`, so a dependency can never cross runs.
   *
   * Re-validates acyclicity even though Role C validates the plan first (C03,
   * where it can ask the model for a correction). The cost is a topological
   * sort over a handful of nodes; the cost of storing a cycle is a scheduler
   * that waits forever on prerequisites that can never complete, which is far
   * harder to diagnose than a rejected plan.
   */
  async linkDependencies(runId: string, plan: AgentPlan): Promise<void> {
    assertAcyclic(plan);

    const instances = await this.deps.db
      .selectFrom('agent_instances')
      .select(['id', 'assignment_key'])
      .where('run_id', '=', runId)
      .execute();

    const byAssignment = new Map(instances.map((i) => [i.assignment_key, i.id]));
    const missing = plan.assignments
      .map((a) => a.id)
      .filter((id) => !byAssignment.has(id));
    if (missing.length > 0) {
      throw new ApiError(
        'INVALID_STATE',
        `These assignments have no instance in this run: ${missing.join(', ')}`,
        { assignmentKeys: missing },
      );
    }

    const edges = plan.assignments.flatMap((assignment) =>
      assignment.dependsOn.map((prerequisite) => ({
        run_id: runId,
        agent_id: byAssignment.get(assignment.id)!,
        prerequisite_agent_id: byAssignment.get(prerequisite)!,
      })),
    );
    if (edges.length === 0) return;

    await this.deps.db
      .insertInto('agent_dependencies')
      .values(edges)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /**
   * Assignments whose prerequisites have all completed (section 8.7).
   *
   * "Eligible independent assignments are scheduled without a fixed global
   * active-task cap", so this returns the whole ready set rather than one.
   */
  async readyInstances(runId: string): Promise<AgentInstance[]> {
    const [pending, deps, completed] = await Promise.all([
      this.deps.db
        .selectFrom('agent_instances')
        .selectAll()
        .where('run_id', '=', runId)
        .where('status', '=', 'pending')
        .execute(),
      this.deps.db
        .selectFrom('agent_dependencies')
        .selectAll()
        .where('run_id', '=', runId)
        .execute(),
      this.deps.db
        .selectFrom('agent_instances')
        .select('id')
        .where('run_id', '=', runId)
        .where('status', '=', 'completed')
        .execute(),
    ]);

    const done = new Set(completed.map((r) => r.id));
    return pending
      .filter((row) =>
        deps
          .filter((d) => d.agent_id === row.id)
          .every((d) => done.has(d.prerequisite_agent_id)),
      )
      .map((row) => toAgentInstance(row, deps));
  }

  async listInstances(runId: string): Promise<AgentInstance[]> {
    const [rows, deps] = await Promise.all([
      this.deps.db
        .selectFrom('agent_instances')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('created_at')
        .execute(),
      this.deps.db
        .selectFrom('agent_dependencies')
        .selectAll()
        .where('run_id', '=', runId)
        .execute(),
    ]);
    return rows.map((row) => toAgentInstance(row, deps));
  }

  // -------------------------------------------------------------------------
  // Startup (section 14.4)
  // -------------------------------------------------------------------------

  /**
   * Marks work from previous processes interrupted.
   *
   * Section 14.4 step 2. Called by Role D's startup routine before the server
   * accepts task actions, so nothing can observe a run that looks live but has
   * no process behind it.
   *
   * Clearing the task's active-run pointer is what lets a human retry; without
   * it the unique active-run rule would leave every interrupted task
   * permanently unstartable after a restart.
   */
  async markInterruptedFromPreviousBoots(): Promise<{ runs: number; agents: number }> {
    return this.deps.db.transaction().execute(async (trx) => {
      const now = new Date();

      const agents = await trx
        .updateTable('agent_instances')
        .set({ status: 'interrupted', ended_at: now })
        .where('boot_id', '!=', this.deps.bootId)
        .where('status', 'in', ['pending', 'running', 'needs_input'])
        .returning('id')
        .execute();

      const runs = await trx
        .updateTable('runs')
        .set({ status: 'interrupted', ended_at: now })
        .where('boot_id', '!=', this.deps.bootId)
        .where('status', 'in', ['planning', 'working', 'needs_input'])
        .returning(['id', 'task_id', 'workspace_id'])
        .execute();

      for (const run of runs) {
        await trx
          .updateTable('tasks')
          .set({ status: 'interrupted', active_run_id: null, updated_at: now })
          .where('id', '=', run.task_id)
          .where('active_run_id', '=', run.id)
          .execute();

        await trx
          .updateTable('agent_questions')
          .set({ status: 'canceled', resolved_at: now })
          .where('run_id', '=', run.id)
          .where('status', '=', 'open')
          .execute();

        await appendEvent(trx, {
          workspaceId: run.workspace_id,
          taskId: run.task_id,
          runId: run.id,
          eventKey: `run:${run.id}:interrupted`,
          type: 'task.canceled',
          payload: { reason: 'server restarted during execution' },
        });
      }

      return { runs: runs.length, agents: agents.length };
    });
  }

  // -------------------------------------------------------------------------

  private staleRunError(runId: string): ApiError {
    return new ApiError(
      'RUN_INTERRUPTED',
      'This run is no longer active, or belongs to a previous process.',
      { runId },
    );
  }
}

// ---------------------------------------------------------------------------

function isActiveRun(status: string): boolean {
  return status === 'planning' || status === 'working' || status === 'needs_input';
}

/**
 * Rejects a plan whose dependency graph has a cycle (design §8.3).
 *
 * Foreign keys cannot express this, and §11.2 says so explicitly: "Do not rely
 * only on foreign keys to prevent cycles."
 */
export function assertAcyclic(plan: AgentPlan): void {
  const ids = new Set(plan.assignments.map((a) => a.id));
  const edges = new Map(plan.assignments.map((a) => [a.id, a.dependsOn]));

  for (const assignment of plan.assignments) {
    for (const dependency of assignment.dependsOn) {
      if (!ids.has(dependency)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Assignment "${assignment.id}" depends on "${dependency}", which is not in the plan.`,
          { assignmentIds: [assignment.id, dependency], kind: 'unknown_dependency' },
        );
      }
    }
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      throw new ApiError(
        'VALIDATION_FAILED',
        `Assignments form a dependency cycle: ${cycle.join(' -> ')}`,
        { assignmentIds: cycle, kind: 'cycle' },
      );
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of edges.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, 'done');
  };

  for (const assignment of plan.assignments) visit(assignment.id);
}

function toAgentInstance(
  row: AgentInstanceRow,
  deps: Array<{ agent_id: string; prerequisite_agent_id: string }>,
): AgentInstance {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    agentKey: row.agent_key,
    assignmentKey: row.assignment_key,
    preset: row.preset,
    status: row.status,
    instruction: row.instruction,
    writePaths: row.write_paths,
    dependsOn: deps
      .filter((d) => d.agent_id === row.id)
      .map((d) => d.prerequisite_agent_id),
    baseSha: row.base_sha,
    resultSha: row.result_sha,
    startedAt: toIsoOrNull(row.started_at),
    deadlineAt: toIsoOrNull(row.deadline_at),
    endedAt: toIsoOrNull(row.ended_at),
  };
}
