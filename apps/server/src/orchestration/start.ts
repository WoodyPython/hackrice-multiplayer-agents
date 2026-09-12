import {
  ApiError, ORCHESTRATOR_AGENT_KEY, isActiveRunStatus,
  type AssignmentSchedulingService, type OrchestrationHook, type OrchestratorPlanningService,
  type ScheduleResult, type TaskStatus, type RunStatus,
} from '@app/contracts';
import { AgentExecutionError, type PgAgentLedger } from '../agents/index.js';
import { appendEvent } from '../events/service.js';
import { ModelAdapterError, type ModelAdapter } from '../models/types.js';
import { PgRunStore } from '../runs/run-store.js';
import { CaptureError, StartCapture, type CaptureDeps, type CapturedStart } from './capture.js';
import { PlanningError } from './plan-store.js';
import { SchedulingError } from './scheduler-store.js';

/**
 * C06: the explicit Start hook (design section 2.2, steps 4 onward).
 *
 * B03 creates the run row inside the Start transaction — the row IS the
 * duplicate-start guard — and calls this after commit, with the response
 * already sent. Three obligations follow from that, and every branch below
 * exists to keep one of them:
 *
 *   Never throw back into the caller. Failure is ours to record.
 *   End the run in a terminal state with an event saying why. A run stuck in
 *     `planning` forever is worse than a failed one: nothing recovers from it.
 *   Check the boot before any write. A run from a previous process was marked
 *     interrupted at startup and its late results are rejected (section 14.4).
 */

/** Sweeps agents whose fixed deadline passed while waiting on a human (9.2). */
const DEADLINE_SWEEP_MS = 15_000;

export interface StartDeps extends CaptureDeps {
  ledger: PgAgentLedger;
  adapter: Pick<ModelAdapter, 'getModel'>;
  planner: OrchestratorPlanningService;
  scheduler: AssignmentSchedulingService;
  /** Nothing here has a caller to raise to; report instead of swallowing. */
  onBackgroundError: (error: unknown) => void;
  sweepIntervalMs?: number;
}

interface Attempt {
  planningInstanceId?: string;
  promise: Promise<void>;
}

export class StartOrchestrator implements OrchestrationHook {
  private readonly capture: StartCapture;
  private readonly runs: PgRunStore;
  private readonly attempts = new Map<string, Attempt>();
  private sweep?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly deps: StartDeps) {
    this.capture = new StartCapture(deps);
    this.runs = new PgRunStore(deps);
  }

  /** Starts the deadline sweep. One orchestrator per runtime owns it. */
  open(): void {
    if (this.sweep || this.closed) return;
    this.sweep = setInterval(() => {
      void this.deps.ledger.sweepDeadlines().catch(this.deps.onBackgroundError);
    }, this.deps.sweepIntervalMs ?? DEADLINE_SWEEP_MS);
    this.sweep.unref?.();
  }

  onRunCreated(input: { workspaceId: string; taskId: string; runId: string }): void {
    // B03 already suppresses the hook for an idempotent replay, so a run seen
    // here is genuinely new. This guards a redelivery, not a replay.
    if (this.closed || this.attempts.has(input.runId)) return;
    const attempt: Attempt = { promise: Promise.resolve() };
    attempt.promise = this.execute(input, attempt)
      .catch((error: unknown) => { this.deps.onBackgroundError(error); })
      .finally(() => { this.attempts.delete(input.runId); });
    this.attempts.set(input.runId, attempt);
  }

  /** B03 has already written the durable cancellation under the task lock; what
   * is left is the local work that would otherwise keep calling a provider. */
  onCancelRequested(input: { workspaceId: string; taskId: string; runId: string }): void {
    const attempt = this.attempts.get(input.runId);
    if (attempt?.planningInstanceId) this.deps.planner.cancel(attempt.planningInstanceId);
    this.deps.scheduler.cancel(input.runId);
    void this.deps.ledger.sweepDeadlines().catch(this.deps.onBackgroundError);
  }

  /** Shutdown: stop sweeping, abort local scopes, and let writes in flight
   * settle. Runs still active at exit are marked interrupted at next startup. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    for (const [runId, attempt] of this.attempts) {
      if (attempt.planningInstanceId) this.deps.planner.cancel(attempt.planningInstanceId);
      this.deps.scheduler.cancel(runId);
    }
    await Promise.allSettled([...this.attempts.values()].map((attempt) => attempt.promise));
  }

  // -------------------------------------------------------------------------

  private async execute(input: { workspaceId: string; taskId: string; runId: string }, attempt: Attempt): Promise<void> {
    const { workspaceId, taskId, runId } = input;
    let captured: CapturedStart;
    try {
      captured = await this.capture.capture(workspaceId, taskId, runId);
      // Steps 4 to 6. Refuses a run from a previous boot, so a slow capture
      // cannot resurrect one that startup already marked interrupted.
      await this.runs.recordCapture(runId, {
        inputSnapshotSha: captured.inputSnapshotSha, contextManifest: captured.context.manifest,
      });
      await this.event(runId, 'context_captured', {
        inputSnapshotSha: captured.inputSnapshotSha,
        draftCheckpointSha: captured.draftCheckpointSha,
        materials: captured.context.manifest.materials.length,
        sources: captured.context.sources.length,
        discussionCutoffSeq: captured.context.manifest.discussionCutoffSeq,
        ...(captured.omitted.length ? { omitted: captured.omitted } : {}),
      });
    } catch (error) { await this.fail(runId, error); return; }

    try {
      // Step 7. One planning instance per run, on the task-scoped budget key
      // that a retry reuses rather than resets (section 14.3).
      const planning = await this.deps.ledger.createInstance({
        runId, agentKey: ORCHESTRATOR_AGENT_KEY, assignmentKey: ORCHESTRATOR_AGENT_KEY,
        preset: 'orchestrator', modelId: this.deps.adapter.getModel('orchestrator').modelId,
      });
      attempt.planningInstanceId = planning.id;
      // Step 8. C03 validates and stores the plan atomically with completion.
      await this.deps.planner.plan({ runId, agentInstanceId: planning.id, context: captured.context });
    } catch (error) { await this.fail(runId, error); return; }

    try {
      // Step 9. C05 instantiates the stored graph and dispatches in parallel.
      const result = await this.deps.scheduler.schedule({
        runId, planningInstanceId: attempt.planningInstanceId!, context: captured.context,
      });
      await this.finish(runId, result);
    } catch (error) { await this.fail(runId, error); }
  }

  /** Derives the run's terminal state once every assignment has settled. */
  private async finish(runId: string, result: ScheduleResult): Promise<void> {
    const outcomes = Object.values(result.assignments);
    const has = (status: string) => outcomes.some((outcome) => outcome.status === status);
    if (has('canceled')) {
      await this.settle(runId, 'canceled', 'canceled', 'canceled');
    } else if (has('conflict')) {
      // Section 10.2: a conflict needs explicit human resolution, and saved
      // work stays inspectable. The run is over either way.
      const paths = [...new Set(outcomes.flatMap((outcome) =>
        outcome.status === 'conflict' ? outcome.paths : []))].sort();
      await this.settle(runId, 'incomplete', 'conflict', 'integration_conflict', { paths });
    } else if (has('failed') || has('blocked') || has('pending_integration')) {
      await this.settle(runId, 'incomplete', 'incomplete', 'assignments_incomplete');
    } else {
      // Completion is never inferred from a model saying "done": every
      // assignment holds a durable integration receipt to reach this branch.
      await this.settle(runId, 'completed', 'ready_for_review', 'assignments_integrated');
    }
  }

  private async fail(runId: string, error: unknown): Promise<void> {
    try {
      if (this.superseded(error)) return;
      const reason = failureReason(error);
      const taskStatus: TaskStatus = reason === 'snapshot_conflict' ? 'conflict' : 'incomplete';
      const paths = error instanceof CaptureError && error.paths.length ? { paths: error.paths } : {};
      await this.settle(runId, 'incomplete', taskStatus, reason, paths);
    } catch (failure) {
      // Terminalizing failed too. Nothing else can run for this task until a
      // restart reconciles it, so this must be visible in the process log.
      this.deps.onBackgroundError(failure);
    }
  }

  /**
   * Whether some other writer already owns this run's outcome — a cancel, a
   * newer attempt, a restart sweep, or a deadline that already terminalized it.
   * Settling again would overwrite a more accurate terminal state.
   */
  private superseded(error: unknown): boolean {
    if (error instanceof CaptureError) return error.code === 'inactive';
    if (error instanceof AgentExecutionError) return error.code === 'inactive' || error.code === 'canceled';
    if (error instanceof SchedulingError) return error.code === 'inactive' || error.code === 'already_scheduled';
    if (error instanceof ApiError) return error.code === 'RUN_INTERRUPTED' || error.code === 'RUN_NOT_FOUND';
    return false;
  }

  private async settle(runId: string, status: Extract<RunStatus, 'completed' | 'incomplete' | 'canceled'>,
    taskStatus: TaskStatus, reason: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (status !== 'completed') await this.event(runId, reason, payload);
    await this.runs.settle(runId, status, reason, taskStatus);
  }

  /** Durable, human-readable "why", with no provider or filesystem text in it. */
  private async event(runId: string, reason: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst();
      if (!run || run.boot_id !== this.deps.bootId || !isActiveRunStatus(run.status)) return;
      await appendEvent(trx, {
        workspaceId: run.workspace_id, taskId: run.task_id, runId,
        eventKey: `run:${runId}:start:${reason}`, type: 'agent.waiting',
        payload: { phase: 'start', reason, ...payload },
      });
    });
  }
}

/**
 * A stable code, never a message.
 *
 * Section 13.3 keeps provider text, credentials and internal filesystem
 * locations out of anything a contributor or a later model can read, and a task
 * event is both.
 */
function failureReason(error: unknown): string {
  if (error instanceof CaptureError) return error.code;
  if (error instanceof PlanningError) return `planning_${error.code}`;
  if (error instanceof SchedulingError) return `scheduling_${error.code}`;
  if (error instanceof AgentExecutionError) return `agent_${error.code}`;
  if (error instanceof ModelAdapterError) return `model_${error.code}`;
  if (error instanceof ApiError) return error.code;
  return 'start_failed';
}
