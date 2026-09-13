import { z } from 'zod';

/**
 * Status vocabularies. Every list here must match db/migrations/0001_enums.sql
 * exactly; change both in the same commit.
 */

// --- workspace -------------------------------------------------------------

export const WORKSPACE_STATUSES = ['active', 'archived'] as const;
export const workspaceStatusSchema = z.enum(WORKSPACE_STATUSES);
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

// --- task ------------------------------------------------------------------

export const TASK_KINDS = ['agent_task', 'manual_edit'] as const;
export const taskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof taskKindSchema>;

/** Design section 2.4. */
export const TASK_STATUSES = [
  'posted',
  'planning',
  'working',
  'needs_input',
  'ready_for_review',
  'awaiting_confirmation',
  'conflict',
  'incomplete',
  'interrupted',
  'canceled',
  'completed',
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Settled task statuses. An explicit action may reopen or rerun these tasks.
 *
 * `incomplete` and `interrupted` are deliberately NOT terminal: section 2.4
 * offers manual retry from both, so a stalled editing task keeps its file.
 * Applied tasks awaiting confirmation also release their closed drafts.
 */
export const TERMINAL_TASK_STATUSES = ['completed', 'canceled'] as const;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** States from which a fresh Start is allowed to create a new attempt. */
export const STARTABLE_TASK_STATUSES = [
  'ready_for_review',
  'awaiting_confirmation',
  'completed',
  'posted',
  'incomplete',
  'interrupted',
  'canceled',
  'conflict',
] as const;

export function isStartableTaskStatus(status: TaskStatus): boolean {
  return (STARTABLE_TASK_STATUSES as readonly string[]).includes(status);
}

/** States in which an attempt is live and a new one must be refused. */
export const ACTIVE_TASK_STATUSES = ['planning', 'working', 'needs_input'] as const;

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}

// --- run -------------------------------------------------------------------

export const RUN_STATUSES = [
  'planning',
  'working',
  'needs_input',
  'completed',
  'incomplete',
  'interrupted',
  'canceled',
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Keys the `runs_active_uq` partial unique index. Keep in sync with 0003. */
export const ACTIVE_RUN_STATUSES = ['planning', 'working', 'needs_input'] as const;

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

// --- agent -----------------------------------------------------------------

/** Design section 2.4, agent states. */
export const AGENT_STATUSES = [
  'pending',
  'running',
  'needs_input',
  'completed',
  'failed',
  'timed_out',
  'token_exhausted',
  'canceled',
  'interrupted',
] as const;
export const agentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * An instance in one of these states can never write again (section 11.2:
 * "a terminal/expired instance cannot write"). Every file write, checkpoint,
 * and integration must re-check this against the live row, not a cached copy.
 */
export const TERMINAL_AGENT_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'token_exhausted',
  'canceled',
  'interrupted',
] as const;

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return (TERMINAL_AGENT_STATUSES as readonly string[]).includes(status);
}

/** Design section 8.2. */
export const AGENT_PRESETS = [
  'orchestrator',
  'analyst',
  'writer',
  'coder',
  'reviewer',
] as const;
export const agentPresetSchema = z.enum(AGENT_PRESETS);
export type AgentPreset = z.infer<typeof agentPresetSchema>;

/** Presets the orchestrator may assign. It cannot assign another orchestrator. */
export const WORKER_PRESETS = ['analyst', 'writer', 'coder', 'reviewer'] as const;
export const workerPresetSchema = z.enum(WORKER_PRESETS);
export type WorkerPreset = z.infer<typeof workerPresetSchema>;

/** Section 8.3: reviewer permissions are read-only; write_paths must be empty. */
export const READ_ONLY_PRESETS = ['analyst', 'reviewer'] as const;

export function isReadOnlyPreset(preset: AgentPreset): boolean {
  return (READ_ONLY_PRESETS as readonly string[]).includes(preset);
}

/** The stable agent_key for the planning agent within a task. */
export const ORCHESTRATOR_AGENT_KEY = 'orchestrator';

// --- discussion and questions ----------------------------------------------

export const ACTOR_TYPES = ['guest', 'agent', 'system'] as const;
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof actorTypeSchema>;

/** Design section 2.6. */
export const QUESTION_STATUSES = ['open', 'answered', 'expired', 'canceled'] as const;
export const questionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

// --- drafts ----------------------------------------------------------------

export const DRAFT_STATUSES = ['active', 'closed'] as const;
export const draftStatusSchema = z.enum(DRAFT_STATUSES);
export type DraftStatus = z.infer<typeof draftStatusSchema>;

// --- review and apply ------------------------------------------------------

export const REVIEW_STATUSES = [
  'building',
  'ready',
  'stale',
  'conflict',
  'applied',
  'superseded',
] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

/**
 * Section 11.2: "Review status cannot become applied from stale/conflict/
 * building." Only a ready review is appliable, and the guarded UPDATE in
 * ReviewService.apply must carry `where status = 'ready'`.
 */
export const APPLIABLE_REVIEW_STATUSES = ['ready'] as const;

export function isAppliableReviewStatus(status: ReviewStatus): boolean {
  return (APPLIABLE_REVIEW_STATUSES as readonly string[]).includes(status);
}

export const APPLY_STATUSES = ['pending', 'applied', 'failed', 'ambiguous'] as const;
export const applyStatusSchema = z.enum(APPLY_STATUSES);
export type ApplyStatus = z.infer<typeof applyStatusSchema>;

// --- model calls -----------------------------------------------------------

export const MODEL_CALL_STATUSES = ['reserved', 'reported', 'failed', 'unknown'] as const;
export const modelCallStatusSchema = z.enum(MODEL_CALL_STATUSES);
export type ModelCallStatus = z.infer<typeof modelCallStatusSchema>;

// --- fixed execution limits (design section 9.2) ----------------------------

/** Fixed. No environment override, no frontend setting. */
export const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Applied independently to each (task, agent_key) pair. */
export const TASK_AGENT_TOKEN_BUDGET = 256_000;
