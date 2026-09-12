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
        dependsOn: z.array(z.string().min(1).max(120)).max(50).default([]),
        writePaths: z.array(repoPathSchema).max(50).default([]),
        instruction: z.string().min(1).max(20000),
      }),
    )
    .min(1)
    /**
     * Not a product rule. Section 9.4 explicitly rejects "three assignments per
     * plan" as a fixed limit; this is only a parser bound against a runaway
     * generation, set far above any plausible plan.
     */
    .max(64),
});
export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** Why a plan was rejected, returned to the orchestrator for one repair pass. */
export const planValidationErrorSchema = z.object({
  kind: z.enum([
    'duplicate_assignment_id',
    'unknown_dependency',
    'cycle',
    'invalid_path',
    'reviewer_write_scope',
    'unordered_write_overlap',
  ]),
  assignmentIds: z.array(z.string()),
  message: z.string(),
});
export type PlanValidationError = z.infer<typeof planValidationErrorSchema>;

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
