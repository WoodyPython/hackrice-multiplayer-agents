import {
  ApiError,
  TERMINAL_AGENT_STATUSES,
  type AgentInstance,
  type AgentPlan,
  type ContextManifest,
  type RunStatus,
  eventKeys,
} from '@app/contracts';
import { isUniqueViolation, type Db } from '../db/client.js';
import type { AgentInstanceRow, RunRow } from '../db/types.js';
import { appendEvent } from '../events/service.js';
import { toIso, toIsoOrNull } from '../http/serialize.js';

/**
 * B07: run and agent instance metadata (design sections 8.3, 9.2, 14.4).
 *
 * B03 creates the run row inside the Start transaction; everything here happens
 * afterwards, driven by Role C's orchestration through the hook.
 */

export interface RunStoreDeps {
  db: Db;
  bootId: string;
}

export class PgRunStore {
  constructor(private readonly deps: RunStoreDeps) {}

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Records what the run captured (section 2.2 steps 4 to 6).
   *
   * Guarded on boot: a run from a previous process was marked interrupted at
   * startup, and a late capture from it must not resurrect it (section 14.4,
   * "every active write checks its run/boot identity").
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
      const run = await trx
        .selectFrom('runs')
        .selectAll()
        .where('id', '=', runId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) throw new ApiError('RUN_NOT_FOUND', 'No such run.');
      if (!isActiveRun(run.status)) return;

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
  // Agent instances
  // -------------------------------------------------------------------------

  /**
   * Materialises a validated plan into instances and dependency edges.
   *
   * Role C validates the plan first (design §16.3, C03) because it can ask the
   * model for a corrected one. This re-checks acyclicity anyway: the cost is a
   * topological sort over a handful of nodes, and the consequence of storing a
   * cycle is a scheduler that waits forever on prerequisites that can never
   * complete, which is far harder to diagnose than a rejected plan.
   *
   * Budget rows must already exist; `agent_instances_budget_fk` enforces it, so
   * a missing one is a programming error rather than a user-facing case.
   */
  async createInstancesFromPlan(input: {
    workspaceId: string;
    taskId: string;
    runId: string;
    plan: AgentPlan;
    modelId: string;
    agentKeyFor?: (assignmentId: string) => string;
  }): Promise<AgentInstance[]> {
    assertAcyclic(input.plan);

    const agentKeyFor = input.agentKeyFor ?? ((id: string) => id);

    return this.deps.db.transaction().execute(async (trx) => {
      const byAssignment = new Map<string, string>();

      for (const assignment of input.plan.assignments) {
        try {
          const row = await trx
            .insertInto('agent_instances')
            .values({
              workspace_id: input.workspaceId,
              task_id: input.taskId,
              run_id: input.runId,
              agent_key: agentKeyFor(assignment.id),
              assignment_key: assignment.id,
              preset: assignment.preset,
              model_id: input.modelId,
              instruction: assignment.instruction,
              write_paths: assignment.writePaths,
              boot_id: this.deps.bootId,
              status: 'pending',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          byAssignment.set(assignment.id, row.id);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ApiError(
              'INVALID_STATE',
              `This run already has an assignment named "${assignment.id}".`,
              { assignmentKey: assignment.id },
            );
          }
          throw error;
        }
      }

      const edges = input.plan.assignments.flatMap((assignment) =>
        assignment.dependsOn.map((prerequisite) => ({
          run_id: input.runId,
          agent_id: byAssignment.get(assignment.id)!,
          prerequisite_agent_id: byAssignment.get(prerequisite)!,
        })),
      );
      if (edges.length > 0) {
        await trx.insertInto('agent_dependencies').values(edges).execute();
      }

      const rows = await trx
        .selectFrom('agent_instances')
        .selectAll()
        .where('run_id', '=', input.runId)
        .orderBy('created_at')
        .execute();
      const deps = await trx
        .selectFrom('agent_dependencies')
        .selectAll()
        .where('run_id', '=', input.runId)
        .execute();

      return rows.map((row) => toAgentInstance(row, deps));
    });
  }

  /**
   * Starts an agent's clock (section 9.2).
   *
   * "Set started_at when that agent begins its first execution activity and
   * deadline_at = started_at + 600 seconds." The deadline is derived here, not
   * supplied, so no caller can extend it. Replanning, provider retries, and
   * repeated tool calls all reuse the same instance and therefore the same
   * deadline.
   *
   * Idempotent: a second call returns the existing deadline rather than
   * restarting the clock.
   */
  async start(agentInstanceId: string, timeoutMs: number): Promise<AgentInstance> {
    const now = new Date();
    const started = await this.deps.db
      .updateTable('agent_instances')
      .set({
        status: 'running',
        started_at: now,
        deadline_at: new Date(now.getTime() + timeoutMs),
      })
      .where('id', '=', agentInstanceId)
      .where('boot_id', '=', this.deps.bootId)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();

    if (started) return toAgentInstance(started, []);

    const current = await this.readInstance(agentInstanceId);
    if (current.status === 'running' || current.status === 'needs_input') {
      return toAgentInstance(current, []);
    }
    throw new ApiError(
      'INVALID_STATE',
      `Agent is ${current.status} and cannot be started.`,
      { currentStatus: current.status },
    );
  }

  /**
   * Whether this instance may still write.
   *
   * Section 9.2: at the deadline, "refuse subsequent file writes or checkpoints
   * from late results". Both conditions matter — a terminal status and an
   * expired clock are different reasons for the same answer, and an instance
   * can be past its deadline before anything has swept it.
   */
  async assertWritable(agentInstanceId: string): Promise<AgentInstanceRow> {
    const row = await this.readInstance(agentInstanceId);

    if ((TERMINAL_AGENT_STATUSES as readonly string[]).includes(row.status)) {
      throw new ApiError(
        row.status === 'timed_out' ? 'AGENT_TIMED_OUT' : 'INVALID_STATE',
        `Agent is ${row.status} and can no longer write.`,
        { currentStatus: row.status },
      );
    }
    if (row.boot_id !== this.deps.bootId) {
      throw new ApiError('RUN_INTERRUPTED', 'This agent belongs to a previous run.');
    }
    if (row.deadline_at && new Date(row.deadline_at).getTime() <= Date.now()) {
      throw new ApiError('AGENT_TIMED_OUT', 'This agent passed its deadline.', {
        deadlineAt: toIso(row.deadline_at),
      });
    }
    return row;
  }

  /**
   * Moves an instance to a terminal status.
   *
   * The database trigger refuses a transition out of a terminal status, so a
   * late settle after a timeout is rejected there rather than silently
   * overwriting the recorded outcome.
   */
  async settleInstance(
    agentInstanceId: string,
    status: (typeof TERMINAL_AGENT_STATUSES)[number],
    input?: { resultSha?: string | null },
  ): Promise<void> {
    const row = await this.readInstance(agentInstanceId);
    if ((TERMINAL_AGENT_STATUSES as readonly string[]).includes(row.status)) return;

    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('agent_instances')
        .set({
          status,
          ended_at: new Date(),
          ...(input?.resultSha !== undefined ? { result_sha: input.resultSha } : {}),
        })
        .where('id', '=', agentInstanceId)
        .where('status', 'not in', TERMINAL_AGENT_STATUSES)
        .execute();

      await appendEvent(trx, {
        workspaceId: row.workspace_id,
        taskId: row.task_id,
        runId: row.run_id,
        eventKey: eventKeys.agentSettled(agentInstanceId, status),
        type:
          status === 'completed'
            ? 'agent.completed'
            : status === 'timed_out'
              ? 'agent.timed_out'
              : status === 'token_exhausted'
                ? 'agent.token_exhausted'
                : 'agent.completed',
        payload: { status },
      });
    });
  }

  /** Instances whose prerequisites have all completed (design §8.7). */
  async readyInstances(runId: string): Promise<AgentInstance[]> {
    const rows = await this.deps.db
      .selectFrom('agent_instances')
      .selectAll()
      .where('run_id', '=', runId)
      .where('status', '=', 'pending')
      .execute();
    const deps = await this.deps.db
      .selectFrom('agent_dependencies')
      .selectAll()
      .where('run_id', '=', runId)
      .execute();
    const completed = new Set(
      (
        await this.deps.db
          .selectFrom('agent_instances')
          .select('id')
          .where('run_id', '=', runId)
          .where('status', '=', 'completed')
          .execute()
      ).map((r) => r.id),
    );

    return rows
      .filter((row) =>
        deps
          .filter((d) => d.agent_id === row.id)
          .every((d) => completed.has(d.prerequisite_agent_id)),
      )
      .map((row) => toAgentInstance(row, deps));
  }

  async listInstances(runId: string): Promise<AgentInstance[]> {
    const rows = await this.deps.db
      .selectFrom('agent_instances')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .execute();
    const deps = await this.deps.db
      .selectFrom('agent_dependencies')
      .selectAll()
      .where('run_id', '=', runId)
      .execute();
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
   * it the task would be permanently unstartable after any restart.
   */
  async markInterruptedFromPreviousBoots(): Promise<{
    runs: number;
    agents: number;
  }> {
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

  private async readInstance(agentInstanceId: string): Promise<AgentInstanceRow> {
    const row = await this.deps.db
      .selectFrom('agent_instances')
      .selectAll()
      .where('id', '=', agentInstanceId)
      .executeTakeFirst();
    if (!row) throw new ApiError('RUN_NOT_FOUND', 'No such agent instance.');
    return row;
  }

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
