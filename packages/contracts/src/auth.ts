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
export const usernameSchema = z.string().trim().toLowerCase()
  .min(3, 'Username must be at least 3 characters.')
  .max(32, 'Username must be at most 32 characters.')
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use letters, numbers, dots, dashes, or underscores.');

/** Supabase's password provider requires an email-shaped identifier internally. */
export function usernameEmail(username: string): string {
  const normalized = usernameSchema.parse(username);
  // Escape punctuation so every allowed username becomes a valid, unique email
  // local-part (including names with consecutive or trailing dots).
  const local = normalized.replace(/[._-]/g, (character) =>
    character === '.' ? '_d' : character === '_' ? '_u' : '_h');
  return `${local}@accounts.coflow.local`;
}

export const accountSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  displayName: z.string(),
});
export type Account = z.infer<typeof accountSchema>;

/**
 * A workspace as it appears in the account's own sidebar and home page.
 *
 * `lastActivityAt` is what the list is ordered by. Ordering teams by name is
 * fine for three and useless for twenty: the one you want is almost always the
 * one something happened in most recently.
 *
 * The two optional fields carry the state a returning person needs before
 * clicking — whether this one is put away, and whether it is empty — and are
 * optional so a response from an older server still parses.
 */
export const membershipSchema = z.object({
  workspaceId: uuidSchema,
  name: z.string(),
  role: workspaceRoleSchema,
  joinedAt: z.string(),
  /** Last durable activity, not last edit to the workspace record. */
  lastActivityAt: z.string().optional(),
  archived: z.boolean().optional(),
  /** How many people are in it, so "just me" is visible without opening it. */
  memberCount: z.number().int().nonnegative().optional(),
  /** Open tasks, for the same reason. */
  openTaskCount: z.number().int().nonnegative().optional(),
});
export type Membership = z.infer<typeof membershipSchema>;

/**
 * A workspace this account has opened but does not belong to.
 *
 * "Workspaces I have the link to" is a different set from "workspaces I am in",
 * and before this it could not be recovered at all: a link holder who lost the
 * URL lost the workspace, signed in or not. A visit grants nothing — this list
 * is read from the visitor's own history and every request it leads to is
 * authorized against membership exactly as before.
 */
export const visitedWorkspaceSchema = z.object({
  workspaceId: uuidSchema,
  name: z.string(),
  lastSeenAt: z.string(),
  archived: z.boolean().optional(),
});
export type VisitedWorkspace = z.infer<typeof visitedWorkspaceSchema>;

/** Everything the home page lists, in one read. */
export const workspaceDirectorySchema = z.object({
  workspaces: z.array(membershipSchema),
  visited: z.array(visitedWorkspaceSchema),
});
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;

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

export const createAccountRequestSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(128),
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
