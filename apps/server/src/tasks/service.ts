import type { Transaction } from 'kysely';
import {
  ACTIVE_RUN_STATUSES,
  ApiError,
  type OrchestrationHook,
  type PostTaskRequest,
  type Run,
  type StartTaskRequest,
  type RetryTaskRequest,
  type TaskDetail,
  type TaskSummary,
  type UpdateTaskRequest,
  eventKeys,
} from '@app/contracts';
import { isPgError, isUniqueViolation, type Db } from '../db/client.js';
import type { Database, TaskRow } from '../db/types.js';
import { appendEvent } from '../events/service.js';
import { assertCancelable, assertRevisable, assertTransition } from './transitions.js';
import { toIso } from '../http/serialize.js';
import { prepareRetry, savedOutputs } from '../orchestration/retry-store.js';

/**
 * B03: posted tasks and the Start transaction (design sections 2.1 to 2.4).
 *
 * The load-bearing property of this file is that posting and revising never
 * touch a model, and that Start is a short database transaction which creates
 * exactly one run and then gets out of the way.
 */

export interface TaskServiceDeps {
  db: Db;
  bootId: string;
  /** Role C implements this in C06. Defaults to a recorder in tests. */
  orchestration: OrchestrationHook;
  onOrchestrationError?: (error: unknown, runId: string) => void;
}

type Trx = Transaction<Database>;

export class PgTaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  // -------------------------------------------------------------------------
  // Post (section 2.1)
  // -------------------------------------------------------------------------

  /**
   * Creates a posted task and nothing else.
   *
   * Section 2.1: "It makes no Gemini request and creates no agent execution."
   * No run row, no agent instance, no hook.
   */
  async post(workspaceId: string, input: PostTaskRequest): Promise<TaskDetail> {
    return this.deps.db.transaction().execute(async (trx) => {
      if (input.clientRequestId) {
        const existing = await trx
          .selectFrom('tasks')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('client_request_id', '=', input.clientRequestId)
          .executeTakeFirst();
        if (existing) return this.loadDetail(trx, workspaceId, existing.id);
      }

      let row: TaskRow;
      try {
        row = await trx
          .insertInto('tasks')
          .values({
            workspace_id: workspaceId,
            kind: input.kind,
            manual_source_path: input.manualSourcePath ?? null,
            creator_guest_label: input.creatorGuestLabel,
            title: input.title,
            outcome: input.outcome,
            criteria: input.criteria,
            output_paths: input.outputPaths,
            client_request_id: input.clientRequestId ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        throw manualEditPathTaken(error, input.manualSourcePath ?? null);
      }

      await this.replaceInputs(trx, workspaceId, row.id, input.inputs);

      await appendEvent(trx, {
        workspaceId,
        taskId: row.id,
        eventKey: eventKeys.taskPosted(row.id),
        type: 'task.posted',
        payload: { kind: row.kind, title: row.title },
      });

      return this.loadDetail(trx, workspaceId, row.id);
    });
  }

  // -------------------------------------------------------------------------
  // Revise (section 2.1, 2.3)
  // -------------------------------------------------------------------------

  /**
   * Optimistic update. Section 2.1: "Requirement updates use optimistic version
   * checks so two form saves cannot silently overwrite each other."
   *
   * Section 2.3 permits this during execution; the in-flight result is simply
   * labeled against the older version. Only `completed` is barred.
   */
  async revise(
    workspaceId: string,
    taskId: string,
    input: UpdateTaskRequest,
  ): Promise<TaskDetail> {
    return this.deps.db.transaction().execute(async (trx) => {
      const task = await this.lockTask(trx, workspaceId, taskId);
      assertRevisable(task.status);

      if (task.version !== input.expectedVersion) {
        throw new ApiError(
          'TASK_VERSION_CHANGED',
          'Someone else changed this task. Reload and reapply your edit.',
          { currentVersion: task.version, expectedVersion: input.expectedVersion },
        );
      }

      const nextVersion = task.version + 1;
      await trx
        .updateTable('tasks')
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
          ...(input.outputPaths !== undefined ? { output_paths: input.outputPaths } : {}),
          version: nextVersion,
          updated_at: new Date(),
        })
        .where('id', '=', taskId)
        .execute();

      // Section 2.3 counts selected inputs as requirements, so replacing them
      // bumps the version exactly as an outcome edit does.
      if (input.inputs !== undefined) {
        await this.replaceInputs(trx, workspaceId, taskId, input.inputs);
      }

      await appendEvent(trx, {
        workspaceId,
        taskId,
        eventKey: eventKeys.requirementsChanged(taskId, nextVersion),
        type: 'task.requirements_changed',
        payload: { version: nextVersion },
      });

      return this.loadDetail(trx, workspaceId, taskId);
    });
  }

  // -------------------------------------------------------------------------
  // Start (section 2.2)
  // -------------------------------------------------------------------------

  /**
   * Creates the run row and returns. Steps 1 to 3 of section 2.2.
   *
   * Everything slow — capture, planning, dispatch — happens in the hook, after
   * this transaction has committed and the response has been shaped. The run
   * row IS the duplicate-start guard, which is why it is written before the Git
   * checkpoint rather than after.
   *
   * Two independent guards, both required:
   *   - clientRequestId resolves a REPLAYED request to its original run;
   *   - runs_active_uq rejects a genuinely CONCURRENT second request.
   * Neither alone is sufficient: the first cannot see a request still in
   * flight, and the second cannot tell a retry from a new intent.
   */
  async start(
    workspaceId: string,
    taskId: string,
    input: StartTaskRequest,
    retry?: RetryTaskRequest,
  ): Promise<{ run: Run; taskStatus: TaskDetail['status']; idempotentReplay: boolean }> {
    const result = await this.deps.db.transaction().execute(async (trx) => {
      const task = await this.lockTask(trx, workspaceId, taskId);

      const replay = await trx
        .selectFrom('runs')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('client_request_id', '=', input.clientRequestId)
        .executeTakeFirst();
      if (replay) {
        return { run: toRun(replay), taskStatus: task.status, idempotentReplay: true };
      }

      if (task.version !== input.expectedVersion) {
        throw new ApiError(
          'TASK_VERSION_CHANGED',
          'This task changed since you loaded it. Review the update before starting.',
          { currentVersion: task.version, expectedVersion: input.expectedVersion },
        );
      }

      assertTransition(task.status, 'planning', 'start this task');
      const retryRecord = retry ? await prepareRetry(trx, workspaceId, taskId, retry) : undefined;

      const workspace = await trx
        .selectFrom('workspaces')
        .select('guidance_version')
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow();

      const previous = await trx
        .selectFrom('runs')
        .select((eb) => eb.fn.max('attempt').as('attempt'))
        .where('task_id', '=', taskId)
        .executeTakeFirst();

      let runRow;
      try {
        runRow = await trx
          .insertInto('runs')
          .values({
            workspace_id: workspaceId,
            task_id: taskId,
            attempt: (previous?.attempt ?? 0) + 1,
            task_version: task.version,
            guidance_version: workspace.guidance_version,
            // Section 2.3: entries above this never enter any agent context for
            // this run. Fixed here, at creation, and never edited.
            discussion_cutoff_seq: task.discussion_seq,
            client_request_id: input.clientRequestId,
            boot_id: this.deps.bootId,
            status: 'planning',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error, 'runs_active_uq')) {
          throw new ApiError(
            'TASK_ALREADY_RUNNING',
            'This task is already running. Stop it before starting another attempt.',
          );
        }
        throw error;
      }

      try {
        await trx
          .updateTable('tasks')
          .set({ status: 'planning', active_run_id: runRow.id, updated_at: new Date() })
          .where('id', '=', taskId)
          .execute();
      } catch (error) {
        // An editing task leaving a terminal state can collide with another
        // task that claimed its file in the meantime. See manualEditPathTaken.
        throw manualEditPathTaken(error, task.manual_source_path);
      }

      await appendEvent(trx, {
        workspaceId,
        taskId,
        runId: runRow.id,
        eventKey: eventKeys.taskStarted(runRow.id),
        type: 'task.started',
        payload: { attempt: runRow.attempt, taskVersion: runRow.task_version, ...(retryRecord ? { retry: retryRecord } : {}) },
      });

      return { run: toRun(runRow), taskStatus: 'planning' as const, idempotentReplay: false };
    });

    // After commit. A replay must not re-trigger orchestration.
    if (!result.idempotentReplay) {
      this.notifyRunCreated(workspaceId, taskId, result.run.id);
    }
    return result;
  }

  /**
   * Manual retry (sections 12.1, 14.3).
   *
   * A new attempt at the CURRENT task version, reusing the same task-and-agent
   * budget rows: section 14.3 is explicit that "an exhausted budget remains
   * exhausted on retry", which is why nothing here touches task_agent_budgets.
   *
   * Saved-output selections and the retained plan are pinned atomically with
   * the new run; idempotent replays retain the original selections.
   */
  async retry(
    workspaceId: string,
    taskId: string,
    input: { clientRequestId: string; expectedVersion?: number; savedOutputs?: RetryTaskRequest['savedOutputs'] },
  ): Promise<{ run: Run; idempotentReplay: boolean }> {
    const task = await this.readTask(workspaceId, taskId);
    const started = await this.start(workspaceId, taskId, {
      expectedVersion: input.expectedVersion ?? task.version,
      clientRequestId: input.clientRequestId,
    }, { ...input, savedOutputs: input.savedOutputs ?? [] });
    return { run: started.run, idempotentReplay: started.idempotentReplay };
  }

  async savedOutputs(workspaceId: string, taskId: string) {
    await this.readTask(workspaceId, taskId);
    return savedOutputs(this.deps.db, workspaceId, taskId);
  }

  // -------------------------------------------------------------------------
  // Cancel (section 2.4)
  // -------------------------------------------------------------------------

  async cancel(workspaceId: string, taskId: string): Promise<TaskDetail> {
    const { detail, runId } = await this.deps.db.transaction().execute(async (trx) => {
      const task = await this.lockTask(trx, workspaceId, taskId);
      assertCancelable(task.status);

      const activeRun = await trx
        .selectFrom('runs')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('status', 'in', ACTIVE_RUN_STATUSES)
        .executeTakeFirst();

      const now = new Date();

      if (activeRun) {
        await trx
          .updateTable('runs')
          .set({ status: 'canceled', ended_at: now })
          .where('id', '=', activeRun.id)
          .execute();

        // Section 2.6: "Canceling a run ... resolves its open questions without
        // an answer." Otherwise the task would report needs_input forever.
        await trx
          .updateTable('agent_questions')
          .set({ status: 'canceled', resolved_at: now })
          .where('run_id', '=', activeRun.id)
          .where('status', '=', 'open')
          .execute();

        await trx
          .updateTable('agent_instances')
          .set({ status: 'canceled', ended_at: now })
          .where('run_id', '=', activeRun.id)
          .where('status', 'in', ['pending', 'running', 'needs_input'])
          .execute();
      }

      await trx
        .updateTable('tasks')
        .set({ status: 'canceled', active_run_id: null, updated_at: now })
        .where('id', '=', taskId)
        .execute();

      if (activeRun) {
        await appendEvent(trx, {
          workspaceId,
          taskId,
          runId: activeRun.id,
          eventKey: eventKeys.taskCanceled(activeRun.id),
          type: 'task.canceled',
          payload: {},
        });
      }

      return {
        detail: await this.loadDetail(trx, workspaceId, taskId),
        runId: activeRun?.id ?? null,
      };
    });

    if (runId) {
      try {
        this.deps.orchestration.onCancelRequested({ workspaceId, taskId, runId });
      } catch (error) {
        this.deps.onOrchestrationError?.(error, runId);
      }
    }
    return detail;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    workspaceId: string,
    options: { status?: TaskDetail['status']; limit: number },
  ): Promise<TaskSummary[]> {
    let query = this.deps.db
      .selectFrom('tasks')
      .selectAll('tasks')
      .select((eb) => [
        eb
          .selectFrom('material_links')
          .select((e) => e.fn.countAll<number>().as('c'))
          .whereRef('material_links.task_id', '=', 'tasks.id')
          .as('material_count'),
        eb
          .selectFrom('agent_questions')
          .select((e) => e.fn.countAll<number>().as('c'))
          .whereRef('agent_questions.task_id', '=', 'tasks.id')
          .where('agent_questions.status', '=', 'open')
          .as('open_question_count'),
      ])
      .where('workspace_id', '=', workspaceId)
      .orderBy('updated_at', 'desc')
      .limit(options.limit);

    if (options.status) query = query.where('status', '=', options.status);

    const rows = await query.execute();
    return rows.map((row) => ({
      ...toPostedTask(row),
      creatorGuestLabel: row.creator_guest_label,
      activeRunId: row.active_run_id,
      materialCount: Number(row.material_count ?? 0),
      openQuestionCount: Number(row.open_question_count ?? 0),
      updatedAt: toIso(row.updated_at),
    }));
  }

  async readTask(workspaceId: string, taskId: string): Promise<TaskDetail> {
    return this.loadDetail(this.deps.db, workspaceId, taskId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Serializes every mutation on one task. Nothing slow may run while held. */
  private async lockTask(trx: Trx, workspaceId: string, taskId: string): Promise<TaskRow> {
    const row = await trx
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', taskId)
      .where('workspace_id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new ApiError('TASK_NOT_FOUND', 'No such task in this workspace.');
    return row;
  }

  private notifyRunCreated(workspaceId: string, taskId: string, runId: string): void {
    try {
      this.deps.orchestration.onRunCreated({ workspaceId, taskId, runId });
    } catch (error) {
      // The response has already been shaped; orchestration failing here must
      // not turn a created run into an error. C06 ends the run in a terminal
      // state with an event saying why.
      this.deps.onOrchestrationError?.(error, runId);
    }
  }

  private async replaceInputs(
    trx: Trx,
    workspaceId: string,
    taskId: string,
    inputs: PostTaskRequest['inputs'],
  ): Promise<void> {
    await trx.deleteFrom('task_input_links').where('task_id', '=', taskId).execute();
    if (inputs.length === 0) return;

    try {
      await trx
        .insertInto('task_input_links')
        .values(
          inputs.map((input) => ({
            workspace_id: workspaceId,
            task_id: taskId,
            material_id: input.materialId ?? null,
            draft_file_id: input.draftFileId ?? null,
            approved_path: input.approvedPath ?? null,
            source_version: input.sourceVersion ?? null,
          })),
        )
        .execute();
    } catch (error) {
      if (isPgError(error) && error.code === '23503') {
        // The composite foreign keys carry workspace_id, so this is a material
        // or draft from another workspace (section 11.2).
        throw new ApiError(
          'INPUT_CONFLICT',
          'A selected input does not belong to this workspace.',
        );
      }
      throw error;
    }
  }

  private async loadDetail(
    db: Db | Trx,
    workspaceId: string,
    taskId: string,
  ): Promise<TaskDetail> {
    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', taskId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!row) throw new ApiError('TASK_NOT_FOUND', 'No such task in this workspace.');

    const inputs = await db
      .selectFrom('task_input_links')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute();

    return {
      ...toPostedTask(row),
      manualSourcePath: row.manual_source_path,
      creatorGuestLabel: row.creator_guest_label,
      outputPaths: row.output_paths,
      activeRunId: row.active_run_id,
      discussionSeq: row.discussion_seq,
      inputs: inputs.map((i) => ({
        id: i.id,
        materialId: i.material_id,
        draftFileId: i.draft_file_id,
        approvedPath: i.approved_path,
        sourceVersion: i.source_version,
      })),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Section 2.5 allows one active editing task per workspace and file, enforced
 * by the `tasks_manual_active_uq` partial index.
 *
 * Two different statements can trip it, and both need the same actionable
 * error rather than a bare constraint violation:
 *
 *  - INSERT, when someone opens a file another task already holds;
 *  - UPDATE, in a sequence sections 2.4 and 2.5 do not discuss. Cancel editing
 *    task M1, which frees the path. Someone opens the file again, creating M2.
 *    Retry M1: it leaves its terminal state and two active editing tasks would
 *    exist for one file. The database is right to refuse; the caller needs to
 *    be told to open M2.
 */
function manualEditPathTaken(error: unknown, path: string | null): unknown {
  if (!isUniqueViolation(error, 'tasks_manual_active_uq')) return error;
  return new ApiError(
    'INVALID_STATE',
    `Another editing task already owns ${path ?? 'this file'}. Open that one instead.`,
    { manualSourcePath: path },
  );
}

function toPostedTask(row: TaskRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    title: row.title,
    outcome: row.outcome,
    criteria: row.criteria,
    version: row.version,
    status: row.status,
  };
}

function toRun(row: {
  id: string;
  task_id: string;
  attempt: number;
  task_version: number;
  guidance_version: number;
  discussion_cutoff_seq: number;
  input_snapshot_sha: string | null;
  result_head_sha: string | null;
  status: Run['status'];
  created_at: Date | string;
  ended_at: Date | string | null;
}): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    taskVersion: row.task_version,
    guidanceVersion: row.guidance_version,
    discussionCutoffSeq: row.discussion_cutoff_seq,
    inputSnapshotSha: row.input_snapshot_sha,
    resultHeadSha: row.result_head_sha,
    status: row.status,
    createdAt: toIso(row.created_at),
    endedAt: row.ended_at === null ? null : toIso(row.ended_at),
  };
}
