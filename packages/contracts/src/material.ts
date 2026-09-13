import { z } from 'zod';
import {
  discussionEntryIdSchema,
  guestLabelSchema,
  materialIdSchema,
  taskIdSchema,
  timestampSchema,
  workspaceIdSchema,
} from './ids.js';

/**
 * Reference materials are immutable uploaded inputs (section 3.2). Editing one
 * is not a thing: a newer version gets a new ID, and running agents keep the
 * version they captured.
 */
export const materialSchema = z.object({
  id: materialIdSchema,
  workspaceId: workspaceIdSchema,
  filename: z.string(),
  /** Lowercase hex sha256 of the bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().nonnegative(),
  contentType: z.string(),
  guestLabel: z.string().nullable(),
  createdAt: timestampSchema,
  deletedAt: timestampSchema.nullable(),
});
export type Material = z.infer<typeof materialSchema>;

/**
 * Section 3.4 transport limit. A file/protocol constraint, not an agent quota.
 */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/** Uploaded reference files may be binary and are kept immutable. */
export const MAX_MATERIAL_FILE_BYTES = 10 * 1024 * 1024;

/**
 * UTF-8 formats that may enter the shared editor and agent text context. Other
 * extensions may still be uploaded, but remain immutable reference files.
 */
export const SUPPORTED_TEXT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.css',
  '.html',
  '.json',
  '.sql',
  '.yaml',
  '.yml',
  '.csv',
] as const;

export function isSupportedTextExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Only small, validated text materials can become collaborative drafts. */
export function isEditableMaterial(material: Pick<Material, 'filename' | 'byteSize'>): boolean {
  return isSupportedTextExtension(material.filename) && material.byteSize <= MAX_TEXT_FILE_BYTES;
}

// --- link ------------------------------------------------------------------

/**
 * Section 3.2: "Reattaching an existing material reuses its ID and bytes."
 * Location affects context selection, not privacy.
 */
export const linkMaterialRequestSchema = z
  .object({
    materialId: materialIdSchema,
    /** Omit both to link at workspace level. */
    taskId: taskIdSchema.optional(),
    discussionEntryId: discussionEntryIdSchema.optional(),
  })
  .refine((v) => v.discussionEntryId === undefined || v.taskId !== undefined, {
    message: 'discussionEntryId requires taskId',
  });
export type LinkMaterialRequest = z.infer<typeof linkMaterialRequestSchema>;

export const uploadMaterialMetadataSchema = z.object({
  guestLabel: guestLabelSchema,
  taskId: taskIdSchema.optional(),
  discussionEntryId: discussionEntryIdSchema.optional(),
});
export type UploadMaterialMetadata = z.infer<typeof uploadMaterialMetadataSchema>;
