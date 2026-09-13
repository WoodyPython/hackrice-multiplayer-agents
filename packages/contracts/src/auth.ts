import { z } from 'zod';
import { uuidSchema } from './ids.js';

/**
 * Accounts, workspace membership, and what each role may do.
 *
 * Identity comes from Supabase Auth. Authorization does not: Supabase knows who
 * someone is, never which workspaces they belong to, so every decision in this
 * file is made by our server against our own tables.
 *
 * The vocabulary is deliberately tiny. Two roles and one anonymous tier is
 * enough for "my team" and "someone I shared a link with", and every additional
 * level is another combination that has to be correct on all 46 routes.
 */

export const WORKSPACE_ROLES = ['owner', 'member'] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/**
 * What the current caller may do in the workspace they are asking about.
 *
 * `viewer` is a link holder with no membership: signed in or not, they may read
 * and nothing else. It exists because sharing progress with someone outside the
 * team is worth keeping, but it is the weaker path and every write must be
 * denied by default rather than allowed by omission.
 */
export const ACCESS_LEVELS = ['owner', 'member', 'viewer'] as const;
export const accessLevelSchema = z.enum(ACCESS_LEVELS);
export type AccessLevel = z.infer<typeof accessLevelSchema>;

/** Writing anything at all requires membership. A viewer never qualifies. */
export function canWrite(access: AccessLevel): boolean {
  return access === 'owner' || access === 'member';
}

/** Workspace settings, roles, and invitations stay with owners. */
export function canAdminister(access: AccessLevel): boolean {
  return access === 'owner';
}

export const SESSION_COOKIE = 'coflow_session';
/** Thirty days, refreshed on use. Long enough that "log in once" is true. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Invitations are short-lived: a link that leaks should not stay useful. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const displayNameSchema = z.string().trim().min(1).max(80);
export const emailSchema = z.string().trim().min(3).max(320).email();

export const accountSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  displayName: z.string(),
});
export type Account = z.infer<typeof accountSchema>;

/** A workspace as it appears in the account's own sidebar. */
export const membershipSchema = z.object({
  workspaceId: uuidSchema,
  name: z.string(),
  role: workspaceRoleSchema,
  joinedAt: z.string(),
});
export type Membership = z.infer<typeof membershipSchema>;

export const workspaceMemberSchema = z.object({
  userId: uuidSchema,
  email: z.string(),
  displayName: z.string(),
  role: workspaceRoleSchema,
  joinedAt: z.string(),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  lastWorkspace: uuidSchema.nullable(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

/**
 * The whole of the current caller's state, in one response.
 *
 * One request answers "am I signed in, who am I, which workspaces do I have,
 * and what are my settings", so the app never renders a half-known session.
 */
export const sessionStateSchema = z.object({
  account: accountSchema.nullable(),
  workspaces: z.array(membershipSchema),
  preferences: preferencesSchema.nullable(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * Exchanging a provider token for our session.
 *
 * The browser sends the Supabase access token exactly once. The server verifies
 * it with Supabase, then issues its own cookie; the provider token is never
 * stored by us and never needs to persist in the browser.
 */
export const createSessionRequestSchema = z.object({
  accessToken: z.string().min(1).max(8192),
}).strict();

export const createInvitationRequestSchema = z.object({
  role: workspaceRoleSchema.default('member'),
  /** Optional lock: only this address may accept. */
  email: emailSchema.optional(),
}).strict();

export const invitationSchema = z.object({
  id: uuidSchema,
  role: workspaceRoleSchema,
  email: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/**
 * The token is returned once, at creation, and never again.
 *
 * Only its hash is stored, so a later read of the invitation list cannot
 * reproduce a working link -- the same rule the owner key follows.
 */
export const createdInvitationSchema = invitationSchema.extend({
  token: z.string(),
});
export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

/** What an invitee is shown before they decide to accept. */
export const invitationPreviewSchema = z.object({
  workspaceName: z.string(),
  role: workspaceRoleSchema,
  /** True when the signed-in account's address does not match a locked invite. */
  emailMismatch: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const updatePreferencesRequestSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  lastWorkspace: uuidSchema.nullable().optional(),
}).strict();

export const updateMemberRequestSchema = z.object({
  role: workspaceRoleSchema,
}).strict();

/**
 * Claiming a pre-existing guest workspace.
 *
 * The owner key is the proof, because it is what ownership already meant. The
 * workspace URL is explicitly not sufficient: anyone who was ever sent the link
 * has it, and treating that as ownership would hand every old workspace to
 * whoever opened it first.
 */
export const claimWorkspaceRequestSchema = z.object({
  ownerKey: z.string().min(1).max(200),
}).strict();
