import { z } from 'zod';
import { workspaceFilePathSchema } from './paths.js';
import {
  clientRequestIdSchema,
  draftFileIdSchema,
  guestLabelSchema,
  materialIdSchema,
  repoPathSchema,
  runIdSchema,
  taskIdSchema,
  timestampSchema,
  workspaceIdSchema,
} from './ids.js';
import { taskKindSchema, taskStatusSchema } from './enums.js';

/**
 * Design section 12.3, `PostedTask`. Kept field-for-field.
 */
export const postedTaskSchema = z.object({
  id: taskIdSchema,
  workspaceId: workspaceIdSchema,
  kind: taskKindSchema,
  title: z.string(),
  outcome: z.string(),
  criteria: z.array(z.string()),
  version: z.number().int().positive(),
  status: taskStatusSchema,
});
export type PostedTask = z.infer<typeof postedTaskSchema>;

/** The selected-input rows behind section 3.3's context manifest. */
export const taskInputLinkSchema = z.object({
  id: z.string().uuid(),
  materialId: materialIdSchema.nullable(),
  draftFileId: draftFileIdSchema.nullable(),
  approvedPath: z.string().nullable(),
  sourceVersion: z.string().nullable(),
});
export type TaskInputLink = z.infer<typeof taskInputLinkSchema>;

/** Full read shape for the task detail screen. */
export const taskDetailSchema = postedTaskSchema.extend({
  manualSourcePath: z.string().nullable(),
  creatorGuestLabel: z.string(),
  outputPaths: z.array(z.string()),
  activeRunId: runIdSchema.nullable(),
  /** Highest allocated discussion sequence; the next entry gets this plus one. */
  discussionSeq: z.number().int().nonnegative(),
  inputs: z.array(taskInputLinkSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/** Board card shape (section 4.3). */
export const taskSummarySchema = postedTaskSchema.extend({
  creatorGuestLabel: z.string(),
  activeRunId: runIdSchema.nullable(),
  materialCount: z.number().int().nonnegative(),
  discussionCount: z.number().int().nonnegative(),
  openQuestionCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

// --- selected inputs on create/update --------------------------------------

const taskInputSelectionSchema = z
  .object({
    materialId: materialIdSchema.optional(),
    draftFileId: draftFileIdSchema.optional(),
    approvedPath: workspaceFilePathSchema.optional(),
    sourceVersion: z.string().max(200).optional(),
  })
  .refine(
    (v) =>
      [v.materialId, v.draftFileId, v.approvedPath].filter(
        (x) => x !== undefined,
      ).length === 1,
    { message: 'exactly one of materialId, draftFileId, approvedPath' },
  );

// --- post ------------------------------------------------------------------

/**
 * Section 2.1: "It creates a posted task and opens its discussion. It makes no
 * Gemini request and creates no agent execution."
 */
export const postTaskRequestSchema = z.object({
  kind: taskKindSchema.default('agent_task'),
  /** Required when kind is manual_edit; forbidden otherwise. */
  manualSourcePath: workspaceFilePathSchema.optional(),
  title: z.string().trim().min(1).max(200),
  outcome: z.string().max(10000).default(''),
  criteria: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  outputPaths: z.array(workspaceFilePathSchema).max(50).default([]),
  inputs: z.array(taskInputSelectionSchema).max(100).default([]),
  creatorGuestLabel: guestLabelSchema,
  clientRequestId: clientRequestIdSchema.optional(),
}).refine(
  (v) => (v.kind === 'manual_edit') === (v.manualSourcePath !== undefined),
  { message: 'manualSourcePath is required for manual_edit and forbidden otherwise' },
);
export type PostTaskRequest = z.infer<typeof postTaskRequestSchema>;

// --- revise ----------------------------------------------------------------

/**
 * Section 2.1: "Requirement updates use optimistic version checks so two form
 * saves cannot silently overwrite each other."
 *
 * Section 2.3: a change here increments the task version, and any in-flight
 * result becomes labeled against the older version.
 */
export const updateTaskRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    outcome: z.string().max(10000).optional(),
    criteria: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
    outputPaths: z.array(workspaceFilePathSchema).max(50).optional(),
    /** When present, replaces the selected-input set wholesale. */
    inputs: z.array(taskInputSelectionSchema).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 1, {
    message: 'at least one field besides expectedVersion must be supplied',
  });
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

/** Body of a TASK_VERSION_CHANGED error, so a form can rebase instead of guess. */
export const taskVersionConflictDetailsSchema = z.object({
  currentVersion: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
});
export type TaskVersionConflictDetails = z.infer<
  typeof taskVersionConflictDetailsSchema
>;

// --- start -----------------------------------------------------------------

/**
 * Section 2.2. Both guards are required:
 *  - clientRequestId makes a REPLAYED request resolve to its original run;
 *  - the unique active-run index rejects a genuinely CONCURRENT second request.
 * Neither alone is sufficient.
 */
export const startTaskRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  clientRequestId: clientRequestIdSchema,
});
export type StartTaskRequest = z.infer<typeof startTaskRequestSchema>;

export const startTaskResponseSchema = z.object({
  runId: runIdSchema,
  attempt: z.number().int().positive(),
  taskStatus: taskStatusSchema,
  /** True when this request replayed an existing run rather than creating one. */
  idempotentReplay: z.boolean(),
});
export type StartTaskResponse = z.infer<typeof startTaskResponseSchema>;

// --- cancel ----------------------------------------------------------------

export const cancelTaskRequestSchema = z.object({
  clientRequestId: clientRequestIdSchema.optional(),
});
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;

// --- list ------------------------------------------------------------------

export const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
