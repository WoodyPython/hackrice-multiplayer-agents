import { z } from 'zod';

/**
 * Identifier and path primitives.
 *
 * Section 6.2: "Use random IDs, not display names or uploaded filenames, in
 * filesystem directory selection." Workspace, task, and agent IDs end up in
 * /data/repos/<workspace-id>.git and worktree paths, and in Yjs room names.
 * Validating them as UUIDs at every route boundary is what makes section 12.1's
 * "a caller cannot pass an arbitrary room name that opens a filesystem path"
 * true rather than aspirational.
 */
export const uuidSchema = z.string().uuid();

export const workspaceIdSchema = uuidSchema;
export const taskIdSchema = uuidSchema;
export const runIdSchema = uuidSchema;
export const agentInstanceIdSchema = uuidSchema;
export const draftFileIdSchema = uuidSchema;
export const materialIdSchema = uuidSchema;
export const reviewIdSchema = uuidSchema;
export const discussionEntryIdSchema = uuidSchema;
export const questionIdSchema = uuidSchema;

export type WorkspaceId = string;
export type TaskId = string;
export type RunId = string;
export type AgentInstanceId = string;
export type DraftFileId = string;
export type MaterialId = string;
export type ReviewId = string;
export type DiscussionEntryId = string;
export type QuestionId = string;

/** A 40-character lowercase hex Git object ID. */
export const shaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-char hex SHA');
export type Sha = string;

/**
 * Idempotency key supplied by the browser. Scoped per task per operation, so
 * the same string on two different tasks is two different operations.
 */
export const clientRequestIdSchema = z.string().min(1).max(200);

/** Unverified display label (section 1.3). Never a permission credential. */
export const guestLabelSchema = z.string().trim().min(1).max(80);

/**
 * A repository-relative path.
 *
 * Section 13.1 rejects parent traversal, absolute paths, and Git metadata. This
 * is the shared syntactic gate; Role D's file service still resolves the real
 * path and re-checks it against the worktree root, because a syntactic check
 * alone cannot see symlinks.
 */
export const repoPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:/.test(p), {
    message: 'path must be relative',
  })
  .refine((p) => !p.split(/[\\/]/).includes('..'), {
    message: 'path must not traverse upward',
  })
  .refine((p) => !p.split(/[\\/]/).some((seg) => seg === '.git'), {
    message: 'path must not touch Git metadata',
  })
  .refine((p) => !p.includes('\0'), { message: 'path must not contain NUL' })
  .refine((p) => !/(^|[\\/])\s|\s([\\/]|$)/.test(p), {
    message: 'path segments must not be space-padded',
  });

/** ISO-8601 timestamp as serialized over the API. */
export const timestampSchema = z.string().datetime({ offset: true });
