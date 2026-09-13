import { z } from 'zod';
import { agentPresetSchema, agentStatusSchema, type AgentStatus } from './enums.js';
import { agentInstanceIdSchema, runIdSchema, taskIdSchema, timestampSchema } from './ids.js';
import { reviewChangedFileSchema } from './review.js';

/**
 * Agent histories for the History screen: what a finished agent thought, did,
 * and changed.
 *
 * Only agents that are done working appear. A running agent's trace is still
 * being written, and the Agents page already follows live work.
 */
export const FINISHED_AGENT_STATUSES = [
  'completed', 'failed', 'timed_out', 'token_exhausted', 'canceled', 'interrupted',
] as const satisfies readonly AgentStatus[];

export function isFinishedAgentStatus(status: AgentStatus): boolean {
  return (FINISHED_AGENT_STATUSES as readonly string[]).includes(status);
}

/**
 * How long any one recorded string may be. Traces are evidence of reasoning,
 * not a second copy of the files: full file text is already in the diff.
 */
export const AGENT_TRACE_TEXT_MAX = 20_000;
export const AGENT_TRACE_VALUE_MAX = 600;

export const AGENT_TRACE_STEP_KINDS = ['model_turn', 'tool_results'] as const;
export type AgentTraceStepKind = (typeof AGENT_TRACE_STEP_KINDS)[number];

export const agentTraceToolCallSchema = z.object({
  name: z.string(),
  /** Clipped: long values such as proposed file text are shortened. */
  arguments: z.record(z.string(), z.unknown()),
});

export const agentTraceToolResultSchema = z.object({
  name: z.string(),
  outcome: z.enum(['ok', 'error']),
  errorCode: z.string().nullable(),
  /** Clipped; a read's file text is shortened to a preview. */
  detail: z.record(z.string(), z.unknown()),
});

/** What the stored `content` column holds for each kind. */
export const agentModelTurnContentSchema = z.object({
  /**
   * The provider's thought summary. Generated text describing the model's
   * reasoning — not a verbatim chain of thought, and not verified.
   */
  thoughts: z.string().nullable(),
  /** Visible text the model returned alongside or instead of tool calls. */
  text: z.string().nullable(),
  toolCalls: z.array(agentTraceToolCallSchema),
  finishReason: z.string().nullable(),
});
export const agentToolResultsContentSchema = z.object({
  results: z.array(agentTraceToolResultSchema),
});

export const agentTraceStepSchema = z.discriminatedUnion('kind', [
  agentModelTurnContentSchema.extend({ kind: z.literal('model_turn'), id: z.string(), createdAt: timestampSchema }),
  agentToolResultsContentSchema.extend({ kind: z.literal('tool_results'), id: z.string(), createdAt: timestampSchema }),
]);
export type AgentTraceStep = z.infer<typeof agentTraceStepSchema>;

export const agentHistoryEntrySchema = z.object({
  agentInstanceId: agentInstanceIdSchema,
  taskId: taskIdSchema,
  taskTitle: z.string(),
  runId: runIdSchema,
  attempt: z.number().int().positive(),
  assignmentKey: z.string(),
  preset: agentPresetSchema,
  status: agentStatusSchema,
  instructionSummary: z.string(),
  writePaths: z.array(z.string()),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  /** Generated completion summary; null when the agent did not complete. */
  summary: z.string().nullable(),
  stepCount: z.number().int().nonnegative(),
});
export type AgentHistoryEntry = z.infer<typeof agentHistoryEntrySchema>;

export const listAgentHistoryResponseSchema = z.object({
  agents: z.array(agentHistoryEntrySchema),
});
export type ListAgentHistoryResponse = z.infer<typeof listAgentHistoryResponseSchema>;

export const agentHistoryDetailSchema = z.object({
  agent: agentHistoryEntrySchema,
  limitations: z.array(z.string()),
  /** The recorded failure code for an agent that failed, else null. */
  failureCode: z.string().nullable(),
  steps: z.array(agentTraceStepSchema),
  /**
   * The agent's own work: its base commit against its last accepted
   * checkpoint, limited to its write paths. Same file shape as a review diff.
   * `available: false` means the commits could not be read, not "no changes".
   */
  changes: z.object({
    available: z.boolean(),
    changedFiles: z.array(reviewChangedFileSchema),
  }),
});
export type AgentHistoryDetail = z.infer<typeof agentHistoryDetailSchema>;

/**
 * Shorten long strings inside a JSON-like value so a trace row stays small.
 * Arrays and objects are bounded too; nothing here is ever interpreted.
 */
export function clipTraceValue(value: unknown, max = AGENT_TRACE_VALUE_MAX, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length <= max ? value : `${value.slice(0, max)}… (${value.length} characters)`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 5) return '…';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => clipTraceValue(item, max, depth + 1));
    return value.length > 50 ? [...items, `… (${value.length - 50} more)`] : items;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 50)
    .map(([key, item]) => [key, clipTraceValue(item, max, depth + 1)]));
}
