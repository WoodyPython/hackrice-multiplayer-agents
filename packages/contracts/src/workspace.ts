import { z } from 'zod';
import { accessLevelSchema } from './auth.js';
import { timestampSchema, workspaceIdSchema } from './ids.js';
import { workspaceStatusSchema } from './enums.js';

/** Header carrying the owner key on owner-only operations (section 12.2). */
export const OWNER_KEY_HEADER = 'x-owner-key';

/**
 * Section 12.2: "Do not accept an isOwner flag, guest label, or claimed creator
 * ID instead." The key is compared against the stored hash, server-side, on
 * every owner operation. Hiding a button is not a check.
 */
export const ownerKeySchema = z.string().min(20).max(200);

// --- read shape ------------------------------------------------------------

/**
 * What a browser holding the contribution link may read. Never includes
 * owner_key_hash.
 */
export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  name: z.string(),
  purpose: z.string(),
  guidance: z.string(),
  guidanceVersion: z.number().int().positive(),
  status: workspaceStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /**
   * True only when the caller is an owner of this workspace. Advisory: it
   * drives what the UI renders, never what the server permits.
   */
  isOwner: z.boolean(),
  /**
   * The caller's level in this workspace. `viewer` is a link holder with no
   * membership -- signed in or not -- who may read and nothing else.
   *
   * Optional so a response from an older server still parses.
   */
  access: accessLevelSchema.optional(),
  /**
   * True while a pre-accounts workspace is still waiting to be claimed, so the
   * UI can offer the claim flow rather than a dead end.
   */
  unclaimed: z.boolean().optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

// --- create ----------------------------------------------------------------

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  purpose: z.string().max(4000).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

/**
 * Section 1.2: the owner key is "returned once to the creating browser".
 * This is the only response that ever contains it. There is no endpoint that
 * reads it back, and no recovery flow.
 */
export const createWorkspaceResponseSchema = z.object({
  workspaceId: workspaceIdSchema,
  /** Contains no secret. Safe to paste anywhere. */
  contributionUrl: z.string().url(),
  /**
   * Null for a workspace created by an account, which is every new one.
   *
   * Ownership is a membership row now. The key survives only so a workspace
   * made before accounts can be claimed, and no fresh one is ever minted.
   */
  ownerKey: z.string().nullable(),
});
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;

// --- update ----------------------------------------------------------------

/**
 * Owner-only (section 1.4). `guidance_version` increments only when the
 * guidance text actually changes: section 11.5 re-checks the stored guidance
 * version at Apply, so bumping it for a name edit would needlessly invalidate
 * every pending review.
 */
export const updateWorkspaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    purpose: z.string().max(4000).optional(),
    guidance: z.string().max(20000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field must be supplied',
  });
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;
