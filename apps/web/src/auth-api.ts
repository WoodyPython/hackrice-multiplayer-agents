import {
  apiErrorBodySchema, membershipSchema, preferencesSchema, sessionStateSchema,
  workspaceMemberSchema, createdInvitationSchema, invitationSchema,
  invitationPreviewSchema, workspaceDirectorySchema, ApiError,
  usernameEmail,
  type Preferences, type SessionState, type WorkspaceDirectory, type WorkspaceRole,
} from "@app/contracts";
import { z } from "zod";

/**
 * Signing in, and everything that depends on having an account.
 *
 * Two hops, deliberately:
 *
 * 1. The browser authenticates with Supabase directly, using the publishable
 *    key. That key is designed to be public and is the only credential the
 *    browser ever holds; passwords go to Supabase and never touch our server.
 * 2. The resulting access token is handed to our server exactly once, which
 *    verifies it with Supabase and replies with an HttpOnly session cookie.
 *
 * After step 2 the provider token is discarded. It is never written to
 * localStorage, so there is nothing for a script to steal, and every later
 * request -- including the SSE stream and the Yjs socket, which cannot send
 * headers at all -- is authenticated by the cookie the browser sends itself.
 */

const supabaseSessionSchema = z.object({
  access_token: z.string().min(1),
});

const supabaseErrorSchema = z.object({
  error_description: z.string().optional(),
  msg: z.string().optional(),
  message: z.string().optional(),
});

export class AuthError extends Error {
  constructor(override readonly message: string) {
    super(message);
  }
}

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

/** Read from Vite's env at build time; both values are public by design. */
export function supabaseConfig(): SupabaseConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
    | string
    | undefined;
  if (!url || !publishableKey) return null;
  return { url: url.replace(/\/+$/, ""), publishableKey };
}

export class AuthApi {
  constructor(
    private readonly config: SupabaseConfig | null,
    private readonly transport: typeof fetch = (...args) => fetch(...args),
  ) {}

  get configured(): boolean {
    return this.config !== null;
  }

  private async supabase(path: string, body: unknown): Promise<unknown> {
    if (!this.config) {
      throw new AuthError(
        "Sign-in is not configured for this deployment. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.",
      );
    }
    const response = await this.transport(`${this.config.url}/auth/v1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: this.config.publishableKey,
      },
      body: JSON.stringify(body),
      // Supabase is a third party: never send it our session cookie.
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = supabaseErrorSchema.safeParse(data);
      const detail = parsed.success
        ? (parsed.data.error_description ?? parsed.data.msg ?? parsed.data.message)
        : undefined;
      const text = detail ?? "That did not work. Check the details and try again.";
      throw new AuthError(/invalid login credentials/i.test(text)
        ? "Incorrect username or password."
        : text);
    }
    return data;
  }

  /** Hand a verified provider token to our server for a session cookie. */
  private async exchange(accessToken: string): Promise<SessionState> {
    const response = await this.transport("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken }),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorBodySchema.safeParse(data);
      throw new AuthError(
        parsed.success && parsed.data.error.code === "AUTH_REQUIRED"
          ? "That sign-in could not be verified. Try again."
          : "Could not start a session. Try again.",
      );
    }
    return sessionStateSchema.parse(data);
  }

  async signIn(username: string, password: string): Promise<SessionState> {
    const data = await this.supabase("/token?grant_type=password", {
      email: usernameEmail(username),
      password,
    });
    return this.exchange(supabaseSessionSchema.parse(data).access_token);
  }

  async signUp(username: string, password: string): Promise<SessionState> {
    const response = await this.transport("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username.trim().toLowerCase(), password }),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorBodySchema.safeParse(data);
      throw new AuthError(parsed.success
        ? parsed.data.error.message
        : "Could not create the account. Try again.");
    }
    return sessionStateSchema.parse(data);
  }

  async current(signal?: AbortSignal): Promise<SessionState> {
    const response = await this.transport("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (response.status === 401) return { account: null, workspaces: [], preferences: null };
    if (!response.ok) throw new AuthError("Could not check your session. Try again.");
    return sessionStateSchema.parse(await response.json());
  }

  async signOut(): Promise<void> {
    const response = await this.transport("/api/auth/session", {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new AuthError("Could not sign out. Try again.");
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.transport(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorBodySchema.safeParse(data);
      throw new ApiError(
        parsed.success ? parsed.data.error.code : "INTERNAL_ERROR",
        undefined,
        parsed.success ? parsed.data.error.details : undefined,
      );
    }
    return data;
  }

  async savePreferences(patch: Partial<Preferences>): Promise<Preferences> {
    return preferencesSchema.parse(
      await this.json("/api/auth/preferences", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    );
  }

  /**
   * The home page's list: workspaces I belong to, and ones I have opened.
   *
   * Separate from `current()` because it is read on a different rhythm and
   * carries the counts and activity times only the home page draws. The session
   * read stays small, because it runs on every page load.
   */
  async directory(signal?: AbortSignal): Promise<WorkspaceDirectory> {
    return workspaceDirectorySchema.parse(
      await this.json("/api/auth/workspaces", signal ? { signal } : {}),
    );
  }

  /**
   * Leave a workspace.
   *
   * A distinct route from removing somebody else, so the server can tell them
   * apart: leaving is a member action, removing another person is an owner one.
   */
  async leaveWorkspace(workspaceId: string) {
    await this.json(`/api/workspaces/${workspaceId}/members/me`, {
      method: "DELETE",
    });
  }

  async members(workspaceId: string, signal?: AbortSignal) {
    const data = await this.json(
      `/api/workspaces/${workspaceId}/members`,
      signal ? { signal } : {},
    );
    return z.object({ members: z.array(workspaceMemberSchema) }).parse(data).members;
  }

  async setMemberRole(workspaceId: string, userId: string, role: WorkspaceRole) {
    await this.json(`/api/workspaces/${workspaceId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
  }

  async removeMember(workspaceId: string, userId: string) {
    await this.json(`/api/workspaces/${workspaceId}/members/${userId}`, {
      method: "DELETE",
    });
  }

  async invitations(workspaceId: string, signal?: AbortSignal) {
    const data = await this.json(
      `/api/workspaces/${workspaceId}/invitations`,
      signal ? { signal } : {},
    );
    return z.object({ invitations: z.array(invitationSchema) }).parse(data).invitations;
  }

  async createInvitation(workspaceId: string, input: { role: WorkspaceRole; email?: string }) {
    return createdInvitationSchema.parse(
      await this.json(`/api/workspaces/${workspaceId}/invitations`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async revokeInvitation(workspaceId: string, invitationId: string) {
    await this.json(`/api/workspaces/${workspaceId}/invitations/${invitationId}`, {
      method: "DELETE",
    });
  }

  async previewInvitation(token: string, signal?: AbortSignal) {
    return invitationPreviewSchema.parse(
      await this.json(`/api/invitations/${encodeURIComponent(token)}`, signal ? { signal } : {}),
    );
  }

  async acceptInvitation(token: string) {
    return membershipSchema.parse(
      await this.json(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      }),
    );
  }

  /** Convert a pre-accounts workspace using its owner key as the proof. */
  async claimWorkspace(workspaceId: string, ownerKey: string) {
    return membershipSchema.parse(
      await this.json(`/api/workspaces/${workspaceId}/claim`, {
        method: "POST",
        body: JSON.stringify({ ownerKey }),
      }),
    );
  }
}
