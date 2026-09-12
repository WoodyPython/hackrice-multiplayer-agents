import { z } from 'zod';
import {
  agentInstanceIdSchema,
  repoPathSchema,
  runIdSchema,
  shaSchema,
  taskIdSchema,
  timestampSchema,
} from './ids.js';
import {
  agentPresetSchema,
  agentStatusSchema,
  runStatusSchema,
  workerPresetSchema,
} from './enums.js';

/**
 * One explicit execution attempt (section 2.2).
 *
 * The versions and the discussion cutoff are fixed when the row is created and
 * never edited. Everything after that (snapshot SHA, manifest, result head) is
 * filled in by orchestration once the response has already returned.
 */
export const runSchema = z.object({
  id: runIdSchema,
  taskId: taskIdSchema,
  attempt: z.number().int().positive(),
  taskVersion: z.number().int().positive(),
  guidanceVersion: z.number().int().positive(),
  /** Entries at or below this seq are in context; above it, they are not. */
  discussionCutoffSeq: z.number().int().nonnegative(),
  inputSnapshotSha: shaSchema.nullable(),
  resultHeadSha: shaSchema.nullable(),
  status: runStatusSchema,
  createdAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});
export type Run = z.infer<typeof runSchema>;

/**
 * Section 3.3. The exact inputs a run was built from, captured once at Start.
 */
export const contextManifestSchema = z.object({
  taskVersion: z.number().int().positive(),
  guidanceVersion: z.number().int().positive(),
  discussionCutoffSeq: z.number().int().nonnegative(),
  materials: z.array(
    z.object({ materialId: z.string().uuid(), sha256: z.string() }),
  ),
  approvedPaths: z.array(z.string()),
  approvedCommitSha: shaSchema.nullable(),
  draftCheckpointSha: shaSchema.nullable(),
  draftFileHashes: z.record(z.string(), z.string()),
});
export type ContextManifest = z.infer<typeof contextManifestSchema>;

// --- agents ----------------------------------------------------------------

export const agentInstanceSchema = z.object({
  id: agentInstanceIdSchema,
  runId: runIdSchema,
  taskId: taskIdSchema,
  /** Stable across attempts. Keys the token budget. */
  agentKey: z.string(),
  /** Unique within this run. The plan's assignment id. */
  assignmentKey: z.string(),
  preset: agentPresetSchema,
  status: agentStatusSchema,
  instruction: z.string(),
  writePaths: z.array(z.string()),
  dependsOn: z.array(agentInstanceIdSchema),
  baseSha: shaSchema.nullable(),
  resultSha: shaSchema.nullable(),
  /** Null until the agent begins its first execution activity (section 9.2). */
  startedAt: timestampSchema.nullable(),
  /** startedAt + 600s. Never extended by retries, replanning, or waiting. */
  deadlineAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
});
export type AgentInstance = z.infer<typeof agentInstanceSchema>;

/**
 * Read-only progress display (section 4.5). The browser never sees model IDs,
 * provider settings, budget settings, or timeout controls.
 */
export const agentProgressSchema = agentInstanceSchema
  .omit({ instruction: true })
  .extend({
    instructionSummary: z.string(),
    tokensConsumed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().nonnegative(),
  });
export type AgentProgress = z.infer<typeof agentProgressSchema>;

/**
 * One assignment as the browser sees it (section 4.5), without token figures.
 *
 * A sibling of `agentProgressSchema` rather than a change to it. The token
 * fields there are required, and the ledger has no read method yet, so serving
 * that shape would mean inventing `tokensConsumed: 0` — a number that looks
 * like a measurement and is not one. Section 4.5 marks the token display
 * optional ("if useful"), so it is simply absent until Role C can supply it,
 * at which point the fields are added here additively.
 *
 * `instruction` is omitted for the same reason it is omitted there: a worker
 * instruction runs to 20,000 characters and is not a UI string.
 */
export const assignmentProgressSchema = agentInstanceSchema
  .omit({ instruction: true })
  .extend({ instructionSummary: z.string() });
export type AssignmentProgress = z.infer<typeof assignmentProgressSchema>;

/**
 * Every attempt on a task, newest first, each with its assignments.
 *
 * Grouped by run rather than flattened because assignments are only meaningful
 * inside their attempt: `assignmentKey` is unique within a run, dependencies
 * point at instances of the same run, and retrying produces a fresh set. A flat
 * list would put two attempts' versions of the same assignment side by side
 * with nothing distinguishing them.
 *
 * Previous attempts are retained deliberately. Section 4.7 requires an
 * incomplete task to show "incomplete status and preserved output/checkpoint",
 * which means the failed attempt's work has to stay inspectable after a retry
 * has moved on.
 */
export const taskAttemptSchema = z.object({
  runId: runIdSchema,
  attempt: z.number().int().positive(),
  status: runStatusSchema,
  taskVersion: z.number().int().positive(),
  createdAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  assignments: z.array(assignmentProgressSchema),
});
export type TaskAttempt = z.infer<typeof taskAttemptSchema>;

export const listTaskAgentsResponseSchema = z.object({
  attempts: z.array(taskAttemptSchema),
});
export type ListTaskAgentsResponse = z.infer<typeof listTaskAgentsResponseSchema>;

/**
 * How much of an instruction reaches the browser.
 *
 * Kept next to the schema so the server and any test agree on one number
 * rather than each picking their own.
 */
export const INSTRUCTION_SUMMARY_MAX = 280;

export function summarizeInstruction(instruction: string): string {
  const flat = instruction.replace(/\s+/g, ' ').trim();
  return flat.length <= INSTRUCTION_SUMMARY_MAX
    ? flat
    : `${flat.slice(0, INSTRUCTION_SUMMARY_MAX - 1).trimEnd()}…`;
}

// --- the plan (section 8.3) ------------------------------------------------

/**
 * Design section 12.3, `AgentPlan`. This is model output, so it is parsed with
 * Zod before anything is instantiated (section 12.3: "TypeScript types alone do
 * not validate runtime data").
 *
 * Zod covers shape. The remaining checks from section 8.3 are graph properties
 * Zod cannot express and must run before dispatch:
 *   - dependency IDs exist,
 *   - the graph is acyclic,
 *   - reviewer/analyst assignments declare no write paths,
 *   - assignments with overlapping write scopes have an ordering between them.
 */
export const agentPlanSchema = z.object({
  summary: z.string().min(1).max(4000),
  assignments: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(120),
        preset: workerPresetSchema,
        dependsOn: z.array(z.string().min(1).max(120)).default([]),
        writePaths: z.array(repoPathSchema).default([]),
        instruction: z.string().min(1).max(20000),
      }),
    )
    // Execution tokens/deadline bound generation; there is no step-count quota.
    .min(1),
});
export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** Strict provider output: misspelled fields must not silently become defaults. */
export const orchestratorPlanSchema = agentPlanSchema.extend({
  assignments: z.array(agentPlanSchema.shape.assignments.element.extend({
    dependsOn: agentPlanSchema.shape.assignments.element.shape.dependsOn.removeDefault(),
    writePaths: agentPlanSchema.shape.assignments.element.shape.writePaths.removeDefault(),
  }).strict()).min(1),
}).strict();

/** Why a plan was rejected. Repairs share the original budget and deadline. */
export const planValidationErrorSchema = z.object({
  kind: z.enum([
    'duplicate_assignment_id',
    'unknown_dependency',
    'cycle',
    'invalid_path',
    'reviewer_write_scope',
    'unordered_write_overlap',
    'invalid_shape',
    'invalid_preset',
    'analyst_write_scope',
    'reserved_assignment_id',
    'duplicate_dependency',
    'path_collision',
  ]),
  assignmentIds: z.array(z.string()),
  message: z.string(),
});
export type PlanValidationError = z.infer<typeof planValidationErrorSchema>;

/** C06 supplies an immutable captured context, never fresh live task reads. */
export const planningContextSchema = z.object({
  task: z.object({
    id: taskIdSchema, version: z.number().int().positive(), title: z.string(),
    outcome: z.string(), criteria: z.array(z.string()), outputPaths: z.array(repoPathSchema),
  }),
  guidance: z.string(),
  manifest: contextManifestSchema,
  discussion: z.array(z.object({ seq: z.number().int().nonnegative(), body: z.string() })),
  sources: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('material'), materialId: z.string().uuid(), sha256: z.string(), text: z.string() }),
    z.object({ kind: z.literal('approved'), path: repoPathSchema, text: z.string() }),
    z.object({ kind: z.literal('draft'), path: repoPathSchema, text: z.string() }),
  ])),
});
export type PlanningContext = z.infer<typeof planningContextSchema>;

// --- token accounting (section 9.3) ----------------------------------------

export const taskAgentBudgetSchema = z.object({
  taskId: taskIdSchema,
  agentKey: z.string(),
  tokenBudget: z.number().int().nonnegative(),
  consumedTokens: z.number().int().nonnegative(),
  reservedTokens: z.number().int().nonnegative(),
});
export type TaskAgentBudget = z.infer<typeof taskAgentBudgetSchema>;

export const modelUsageSchema = z.object({
  totalTokens: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  thinkingTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  status: z.enum(['reported', 'unknown']),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;
