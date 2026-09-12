import type {
  AgentInstance,
  AgentPlan,
  ContextManifest,
  ModelUsage,
  Run,
  TaskAgentBudget,
  PlanningContext,
} from './run.js';
import type { AgentQuestion, DiscussionEntry } from './discussion.js';
import type { DraftCapture, DraftFile, DocumentRevisions, TextChange } from './draft.js';
import type { Material } from './material.js';
import type { Review, ReviewSource } from './review.js';
import type { PostedTask, TaskDetail } from './task.js';
import type { Workspace } from './workspace.js';
import type { TaskEventType } from './events.js';
import type { GitReadTarget } from './git.js';

/**
 * Design section 12.4. These are the backend seams between roles. An owner
 * implements its interface; every other role programs against the interface and
 * can stand up a stub to work before the real one lands.
 *
 * Ordering rules from section 12.4 that are NOT expressible in the types and
 * must be honored by callers:
 *   - TaskService.start calls CollaborationService.capture before AgentService.plan.
 *   - ReviewService.apply checks CollaborationService.isCurrent before
 *     GitService.applyExpected.
 */

// --- Role B ----------------------------------------------------------------

export interface WorkspaceService {
  create(input: {
    name: string;
    purpose?: string;
  }): Promise<{ workspaceId: string; contributionUrl: string; ownerKey: string }>;

  /**
   * ownerKey is advisory and only decides the returned isOwner flag, which
   * drives what the UI renders. Every owner-only operation re-checks the key
   * server-side (section 4.6: hiding a button is insufficient).
   */
  resolve(workspaceId: string, ownerKey?: string): Promise<Workspace | null>;

  /** Timing-safe. Returns false for a missing header and for a wrong key alike. */
  checkOwnerKey(workspaceId: string, ownerKey: string | undefined): Promise<boolean>;

  /** Bumps guidance_version only when the guidance text actually changes. */
  updateGuidance(
    workspaceId: string,
    input: { name?: string; purpose?: string; guidance?: string },
  ): Promise<Workspace>;
}

export interface TaskService {
  post(workspaceId: string, input: unknown): Promise<TaskDetail>;

  /** Optimistic: rejects with TASK_VERSION_CHANGED on a stale expectedVersion. */
  revise(workspaceId: string, taskId: string, input: unknown): Promise<TaskDetail>;

  /**
   * Creates the run row and returns immediately (section 2.2 steps 1-3).
   * Capture, planning, and dispatch happen in the orchestration hook, after the
   * response. This method never makes a model call.
   */
  start(
    workspaceId: string,
    taskId: string,
    input: { expectedVersion: number; clientRequestId: string },
  ): Promise<{ run: Run; idempotentReplay: boolean }>;

  answer(
    workspaceId: string,
    taskId: string,
    input: { questionId: string; body: string; guestLabel: string; clientRequestId?: string },
  ): Promise<{ question: AgentQuestion; answerEntry: DiscussionEntry }>;

  cancel(workspaceId: string, taskId: string): Promise<TaskDetail>;

  /**
   * A new attempt with fresh instances and fresh deadlines, reusing the same
   * task-and-agent budget rows and accumulated usage (section 14.3). An
   * exhausted budget stays exhausted.
   */
  retry(workspaceId: string, taskId: string, input: unknown): Promise<Run>;
}

export interface MaterialService {
  upload(
    workspaceId: string,
    input: { filename: string; contentType: string; bytes: Uint8Array; guestLabel: string },
  ): Promise<Material>;

  /** Reattaching existing bytes reuses the material ID rather than copying. */
  link(
    workspaceId: string,
    input: { materialId: string; taskId?: string; discussionEntryId?: string },
  ): Promise<void>;

  readSelected(workspaceId: string, materialId: string): Promise<{
    material: Material;
    bytes: Uint8Array;
  }>;
}

export interface EventService {
  /** Persists first. Idempotent on (taskId, eventKey). */
  append(input: {
    workspaceId: string;
    taskId: string;
    runId?: string | null;
    eventKey: string;
    type: TaskEventType;
    payload?: Record<string, unknown>;
  }): Promise<{ eventId: string; created: boolean }>;

  /** Fire-and-forget refresh hint. Never carries authority (section 5.1). */
  broadcastHint(input: {
    workspaceId: string;
    taskId: string | null;
    type: TaskEventType;
    eventId: string;
  }): Promise<void>;
}

// --- Role D ----------------------------------------------------------------

export interface CollaborationService {
  openRoom(input: { workspaceId: string; taskId: string; path: string }): Promise<DraftFile>;

  /** Revision-guarded: an older snapshot never overwrites a newer one. */
  persist(input: {
    draftFileId: string;
    revision: number;
    yjsState: Uint8Array;
    stateVector: Uint8Array;
  }): Promise<{ applied: boolean; persistedRevision: number }>;

  /** The checkpoint boundary of section 7.4. */
  capture(input: { workspaceId: string; taskId: string }): Promise<DraftCapture>;

  /**
   * Section 7.6: "Apply checks both persisted versions and in-memory dirty/
   * revision state." A persisted-row comparison alone is not sufficient.
   */
  isCurrent(input: {
    taskId: string;
    documentRevisions: DocumentRevisions;
  }): Promise<boolean>;

  /** Closes the task's rooms to new writes after Apply. */
  closeEpoch(input: { taskId: string }): Promise<void>;
}

export interface GitService {
  initialize(workspaceId: string): Promise<{ mainSha: string }>;
  createResult(input: {
    workspaceId: string;
    runId: string;
    baseSha: string;
  }): Promise<{ branch: string; worktreePath: string }>;
  /** allowedPaths is supplied by trusted context selection, never model output. */
  readText(input: {
    workspaceId: string;
    target: GitReadTarget;
    path: string;
    allowedPaths: string[];
  }): Promise<{ path: string; text: string | null; hash: string | null }>;
  /**
   * C02/C04 bind the instance, check its current lifetime/state, and supply its
   * authoritative exact write paths. This Git layer does not query agent state.
   * Each accepted batch is a checkpoint; expected hashes are Git blob SHA-1s.
   */
  applyWorkerChanges(input: {
    workspaceId: string;
    agentInstanceId: string;
    allowedWritePaths: string[];
    changes: TextChange[];
  }): Promise<{ commitSha: string; changedPaths: string[] }>;
  createDraft(input: { workspaceId: string; taskId: string }): Promise<{ branch: string }>;
  createWorker(input: {
    workspaceId: string;
    agentInstanceId: string;
    baseSha: string;
  }): Promise<{ branch: string; worktreePath: string }>;
  checkpoint(input: {
    workspaceId: string;
    taskId: string;
    files: Array<{ path: string; text: string }>;
  }): Promise<{ commitSha: string }>;
  integrate(input: {
    workspaceId: string;
    runId: string;
    agentInstanceId: string;
  }): Promise<{ resultSha: string; conflicts: string[] }>;
  buildReview(input: {
    workspaceId: string;
    taskId: string;
    source: ReviewSource;
  }): Promise<{ candidateSha: string | null; conflicts: string[] }>;
  /** `git update-ref refs/heads/main <candidate> <expectedMain>` (section 10.3). */
  applyExpected(input: {
    workspaceId: string;
    expectedMainSha: string;
    candidateSha: string;
  }): Promise<{ applied: boolean; currentMainSha: string }>;
}

// --- Role C ----------------------------------------------------------------

/** C03 consumes the frozen context that C06 captures after Start. */
export interface OrchestratorPlanningService {
  plan(input: { runId: string; agentInstanceId: string; context: PlanningContext }): Promise<AgentPlan>;
  cancel(agentInstanceId: string): void;
}

export interface AgentService {
  plan(input: { runId: string; manifest: ContextManifest }): Promise<AgentPlan>;
  dispatchReady(input: { runId: string }): Promise<AgentInstance[]>;
  execute(input: { agentInstanceId: string }): Promise<void>;
  /** Atomic reserve-and-reconcile against the (task, agent_key) budget. */
  recordUsage(input: {
    agentInstanceId: string;
    requestKey: string;
    usage: ModelUsage;
  }): Promise<TaskAgentBudget>;
  enforceDeadline(input: { agentInstanceId: string }): Promise<void>;
}

/** C04 execution only. C05 creates the worker/base and dispatches prerequisites. */
export interface WorkerExecutionService {
  execute(input: { agentInstanceId: string; context: PlanningContext }): Promise<import('./worker.js').WorkerResult>;
  cancel(agentInstanceId: string): void;
}

/** Called under the workspace Git lock, after preparing a candidate and just
 * before publishing its ref. The guard owns the short execution-state lock.
 * A rejected guard MUST NOT publish. Never supply a guard from model input.
 */
export type WorkerCommitGuard = (checkpoint: { commitSha: string; changedPaths: string[] },
  publish: () => Promise<void>) => Promise<void>;

/** Separate capability so an old Git implementation cannot silently ignore a guard. */
export interface GuardedWorkerGitService extends Pick<GitService, 'readText'> {
  applyGuardedWorkerChanges(input: Parameters<GitService['applyWorkerChanges']>[0], guard: WorkerCommitGuard):
    ReturnType<GitService['applyWorkerChanges']>;
}

// --- Role D ----------------------------------------------------------------

export interface ReviewService {
  prepare(input: { workspaceId: string; taskId: string }): Promise<Review>;
  resolve(input: { workspaceId: string; reviewId: string; resolutions: unknown }): Promise<Review>;
  /** Called when typing, requirement edits, or guidance changes make it stale. */
  invalidate(input: { taskId: string; reason: string }): Promise<void>;
  apply(input: {
    workspaceId: string;
    reviewId: string;
    candidateSha: string;
  }): Promise<{ appliedCommitSha: string | null; alreadyApplied: boolean }>;
}

// --- The B03 <-> C06 seam --------------------------------------------------

/**
 * Role B creates the run row inside the Start transaction and then hands it
 * off through this hook. Role C implements it in C06.
 *
 * Why the run row exists before capture, inverting section 2.2's original
 * numbering: the row IS the duplicate-start guard, via the unique active-run
 * index. Capture involves a Git checkpoint, and holding a database transaction
 * open across it would serialize unrelated work and risk a long-lived lock.
 * So the guard commits first, and everything slow happens afterwards.
 *
 * Contract for the implementer:
 *  - Never throws into the caller. The Start response has already been sent.
 *  - On failure, transition the run to a terminal status with a task event
 *    saying why. A failed capture must not leave the task with a run stuck in
 *    'planning' forever.
 *  - Check `boot_id` before any write: a run from a previous boot is
 *    interrupted, and a late result from it must be rejected (section 14.4).
 */
export interface OrchestrationHook {
  onRunCreated(input: { workspaceId: string; taskId: string; runId: string }): void;
  onCancelRequested(input: { workspaceId: string; taskId: string; runId: string }): void;
}

/**
 * Stand-in used until C06 lands, and in tests that exercise the Start
 * transaction without orchestration. Records calls so a test can assert the
 * hook fired exactly once.
 */
export class NullOrchestrationHook implements OrchestrationHook {
  readonly created: Array<{ workspaceId: string; taskId: string; runId: string }> = [];
  readonly canceled: Array<{ workspaceId: string; taskId: string; runId: string }> = [];

  onRunCreated(input: { workspaceId: string; taskId: string; runId: string }): void {
    this.created.push(input);
  }

  onCancelRequested(input: { workspaceId: string; taskId: string; runId: string }): void {
    this.canceled.push(input);
  }
}

export type { PostedTask };

// --- The B02 <-> D01 seam --------------------------------------------------

/**
 * Role B writes the workspace record, then signals the Git service here.
 * Role D implements it in D01.
 *
 * Section 1.1: one workspace corresponds to one internally managed Git
 * repository. This hook is how that correspondence is established without the
 * data layer depending on the Git service being present.
 *
 * Contract for the implementer:
 *  - Never throws into the caller. Repository creation must not be able to fail
 *    a workspace creation request; the response has already been shaped.
 *  - Idempotent. It may be called for a workspace whose repository already
 *    exists, after a retry or a restart.
 *  - Not the only path. The Git service must also ensure the repository exists
 *    on first access, under the workspace operation lock, so a workspace whose
 *    hook failed or predates D01 repairs itself rather than staying broken.
 */
export interface WorkspaceLifecycleHook {
  onWorkspaceCreated(input: { workspaceId: string }): void;
}

/** Stand-in used until D01 lands, and in tests. Records calls for assertions. */
export class NullWorkspaceLifecycleHook implements WorkspaceLifecycleHook {
  readonly created: string[] = [];

  onWorkspaceCreated(input: { workspaceId: string }): void {
    this.created.push(input.workspaceId);
  }
}
