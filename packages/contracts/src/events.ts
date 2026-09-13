import { z } from 'zod';
import { runIdSchema, taskIdSchema, timestampSchema, workspaceIdSchema } from './ids.js';

/**
 * Design section 11.5.
 *
 * Events are persisted BEFORE their IDs are broadcast. A broadcast is a hint to
 * refetch; it carries no authority and never changes state. Duplicate or missed
 * broadcasts are normal and must not change what the API reports.
 */
export const TASK_EVENT_TYPES = [
  'task.posted',
  'task.status_changed',
  'discussion.posted',
  'task.started',
  'task.requirements_changed',
  'task.canceled',
  'agent.started',
  'agent.waiting',
  'agent.question_answered',
  'agent.completed',
  'agent.failed',
  'agent.checkpointed',
  'agent.timed_out',
  'agent.token_exhausted',
  'draft.checkpointed',
  'review.ready',
  'review.stale',
  'review.assessed',
  'task.applied',
] as const;

export const taskEventTypeSchema = z.enum(TASK_EVENT_TYPES);
export type TaskEventType = z.infer<typeof taskEventTypeSchema>;

export const taskEventSchema = z.object({
  id: z.string(),
  taskId: taskIdSchema,
  runId: runIdSchema.nullable(),
  type: taskEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
});
export type TaskEvent = z.infer<typeof taskEventSchema>;

/**
 * Deterministic event keys (section 11.5): "Use deterministic event keys where
 * an operation may repeat." A retried append collides on (task_id, event_key)
 * and becomes a no-op instead of a duplicate row.
 *
 * The key must be derived from the operation's identity, never from a clock or
 * a random value.
 */
export const eventKeys = {
  taskPosted: (taskId: string) => `task:${taskId}:posted`,
  taskStarted: (runId: string) => `run:${runId}:started`,
  taskCanceled: (runId: string) => `run:${runId}:canceled`,
  requirementsChanged: (taskId: string, version: number) =>
    `task:${taskId}:version:${version}`,
  agentStarted: (agentId: string) => `agent:${agentId}:started`,
  agentWaiting: (questionId: string) => `question:${questionId}:asked`,
  questionAnswered: (questionId: string) => `question:${questionId}:answered`,
  agentSettled: (agentId: string, status: string) => `agent:${agentId}:${status}`,
  draftCheckpointed: (checkpointId: string) => `checkpoint:${checkpointId}`,
  reviewReady: (reviewId: string, candidateSha: string) =>
    `review:${reviewId}:ready:${candidateSha}`,
  reviewStale: (reviewId: string, revisionMark: string) =>
    `review:${reviewId}:stale:${revisionMark}`,
  /** C07: keyed by the exact candidate examined, so a repeat request for the
   * same candidate is a durable no-op rather than a second charged assessment. */
  reviewAssessed: (reviewId: string, candidateSha: string) =>
    `review:${reviewId}:assessed:${candidateSha}`,
  taskApplied: (applyOperationId: string) => `apply:${applyOperationId}`,
} as const;

/**
 * Realtime channel name. Public and workspace-scoped (section 5.1): "Assume
 * channel messages can be forged by a link holder; carry only refresh hints,
 * not executable commands or approval decisions."
 */
export function workspaceChannel(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/**
 * The entire broadcast payload. Deliberately minimal: enough for a client to
 * decide what to refetch, and nothing a forged message could act on.
 */
export const refreshHintSchema = z.object({
  workspaceId: workspaceIdSchema,
  taskId: taskIdSchema.nullable(),
  eventType: taskEventTypeSchema,
  eventId: z.string(),
});
export type RefreshHint = z.infer<typeof refreshHintSchema>;
