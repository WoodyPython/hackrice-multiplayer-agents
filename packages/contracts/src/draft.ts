import { z } from 'zod';
import { workspaceFilePathSchema } from './paths.js';
import {
  draftFileIdSchema,
  materialIdSchema,
  repoPathSchema,
  shaSchema,
  taskIdSchema,
  timestampSchema,
} from './ids.js';
import { draftStatusSchema } from './enums.js';

/**
 * One editable file inside a task, with a Yjs room keyed by
 * workspace + task + document + epoch (section 7.1).
 *
 * Bumping an epoch creates a NEW row and closes the old one. Section 7.6:
 * "Do not overwrite an active Yjs document with agent output or reuse its old
 * epoch for new approved content."
 */
export const draftFileSchema = z.object({
  id: draftFileIdSchema,
  taskId: taskIdSchema,
  path: z.string(),
  epoch: z.number().int().positive(),
  baseBlobSha: z.string().nullable(),
  /** Last revision durably persisted to Postgres. */
  persistedRevision: z.number().int().nonnegative(),
  status: draftStatusSchema,
  updatedAt: timestampSchema,
});
export type DraftFile = z.infer<typeof draftFileSchema>;

/** Map of draftFileId -> revision. The R of the section 10.1 source tuple. */
export const documentRevisionsSchema = z.record(draftFileIdSchema, z.number().int().nonnegative());
export type DocumentRevisions = z.infer<typeof documentRevisionsSchema>;

/**
 * Design section 12.3, `DraftCapture`. Produced by the checkpoint boundary
 * (section 7.4) and consumed by review preparation.
 */
export const draftCaptureSchema = z.object({
  taskId: taskIdSchema,
  checkpointSha: shaSchema,
  documentRevisions: documentRevisionsSchema,
  contextHash: z.string(),
});
export type DraftCapture = z.infer<typeof draftCaptureSchema>;

/**
 * Design section 12.3, `TextChange`. A worker's proposed replacement.
 * At the Git boundary expectedHash is a lowercase Git blob SHA-1 (40 hex).
 * `expectedHash` null means "this file must not already exist"; `newText` null
 * means deletion and requires a non-null expected hash.
 */
export const textChangeSchema = z.object({
  path: repoPathSchema,
  expectedHash: z.string().nullable(),
  newText: z.string().nullable(),
});
export type TextChange = z.infer<typeof textChangeSchema>;

// --- snapshot persistence (B05) --------------------------------------------

/**
 * A guarded snapshot write. Section 11.3: "Use ordered per-document saves or a
 * revision guard so an older snapshot cannot overwrite a newer one after an
 * asynchronous write completes late."
 *
 * The write must carry `where persisted_revision < revision`, and a rejected
 * write is normal, not an error.
 */
export const persistSnapshotRequestSchema = z.object({
  draftFileId: draftFileIdSchema,
  revision: z.number().int().nonnegative(),
  /** Full Yjs document state. Base64 over the wire, bytea at rest. */
  yjsStateBase64: z.string(),
  stateVectorBase64: z.string(),
});
export type PersistSnapshotRequest = z.infer<typeof persistSnapshotRequestSchema>;

export const persistSnapshotResultSchema = z.object({
  /** False when a newer revision was already persisted; the write was skipped. */
  applied: z.boolean(),
  persistedRevision: z.number().int().nonnegative(),
});
export type PersistSnapshotResult = z.infer<typeof persistSnapshotResultSchema>;

// --- opening a shared draft ------------------------------------------------

/**
 * Section 2.5 "Edit together": creates or finds the one active manual-edit task
 * for this file. The partial unique index makes concurrent opens converge on a
 * single task rather than forking the draft.
 */
export const openDraftRequestSchema = z.object({
  path: workspaceFilePathSchema,
  guestLabel: z.string().trim().min(1).max(80),
  /** Optional immutable source used only to seed a newly opened document. */
  materialId: materialIdSchema.optional(),
});
export type OpenDraftRequest = z.infer<typeof openDraftRequestSchema>;

export const openDraftResponseSchema = z.object({
  taskId: taskIdSchema,
  draftFile: draftFileSchema,
  /** False when an existing active editing task was reused. */
  created: z.boolean(),
});
export type OpenDraftResponse = z.infer<typeof openDraftResponseSchema>;
