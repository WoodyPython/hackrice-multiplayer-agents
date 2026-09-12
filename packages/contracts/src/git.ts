import { z } from 'zod';
import { agentInstanceIdSchema, repoPathSchema, runIdSchema, shaSchema, taskIdSchema, workspaceIdSchema } from './ids.js';
import { textChangeSchema } from './draft.js';

/** Backend-only selectors. Never accept refs or filesystem roots from a model. */
export const gitReadTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), commitSha: shaSchema }),
  z.object({ kind: z.literal('draft'), taskId: taskIdSchema }),
  z.object({ kind: z.literal('worker'), agentInstanceId: agentInstanceIdSchema }),
  z.object({ kind: z.literal('result'), runId: runIdSchema }),
]);
export type GitReadTarget = z.infer<typeof gitReadTargetSchema>;

// Path strings are checked by the Git service's canonical filesystem validator.
// Keeping that check there preserves INVALID_PATH instead of a generic Zod error.
export const createDraftRequestSchema = z.object({ workspaceId: workspaceIdSchema, taskId: taskIdSchema });
export const createWorkerRequestSchema = z.object({
  workspaceId: workspaceIdSchema, agentInstanceId: agentInstanceIdSchema, baseSha: shaSchema,
});
export const createResultRequestSchema = z.object({
  workspaceId: workspaceIdSchema, runId: runIdSchema, baseSha: shaSchema,
});
export const gitBranchResultSchema = z.object({ branch: z.string() });
/** Internal service result only: worktreePath must never enter HTTP/model output. */
export const gitWorktreeResultSchema = gitBranchResultSchema.extend({ worktreePath: z.string() });
export const gitCheckpointRequestSchema = createDraftRequestSchema.extend({
  files: z.array(z.object({ path: z.string(), text: z.string() })),
});
export const gitCheckpointResultSchema = z.object({ commitSha: shaSchema });
export const gitReadTextRequestSchema = z.object({
  workspaceId: workspaceIdSchema, target: gitReadTargetSchema,
  path: z.string(), allowedPaths: z.array(z.string()),
});
export const gitReadTextResultSchema = z.object({
  path: z.string(), text: z.string().nullable(), hash: shaSchema.nullable(),
});
export const applyWorkerChangesRequestSchema = z.object({
  workspaceId: workspaceIdSchema, agentInstanceId: agentInstanceIdSchema,
  allowedWritePaths: z.array(z.string()),
  changes: z.array(textChangeSchema.extend({ path: z.string(), expectedHash: shaSchema.nullable() })),
});
export const applyWorkerChangesResultSchema = gitCheckpointResultSchema.extend({ changedPaths: z.array(z.string()) });

export const gitIntegrateRequestSchema = z.object({
  workspaceId: workspaceIdSchema, runId: runIdSchema, agentInstanceId: agentInstanceIdSchema,
});
/** Conflicts retain the current result head; only an empty list releases dependents. */
export const gitIntegrateResultSchema = z.object({
  resultSha: shaSchema,
  // Full portable-path validation remains in Git, as for every file operation.
  conflicts: z.array(repoPathSchema.refine((path) => !path.includes('\\') && /^(documents|code)\//.test(path)))
    .refine((paths) => paths.every((path, i) => i === 0 || paths[i - 1]! < path)),
});
