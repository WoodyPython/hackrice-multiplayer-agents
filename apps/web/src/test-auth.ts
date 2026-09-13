import type { SessionState } from "@app/contracts";
import type { AuthApi } from "./auth-api";

/**
 * An `AuthApi` that never touches the network.
 *
 * Without one, `AuthProvider` builds a real client and issues a `fetch` for the
 * current session on mount. In jsdom that request neither resolves nor fails
 * usefully, and the stray promise is enough to make unrelated tests flaky
 * depending on what else is running -- which is exactly what it did.
 *
 * Passing this makes each test say whether it is a signed-in scenario, instead
 * of inheriting whatever the default happened to be.
 */
export function stubAuthApi(overrides: Partial<SessionState> = {}): AuthApi {
  const state: SessionState = {
    account: { id: "acc-1", email: "ada@example.test", displayName: "Ada" },
    workspaces: [],
    preferences: { theme: "system", lastWorkspace: null },
    ...overrides,
  };
  return {
    configured: true,
    current: async () => state,
    signIn: async () => state,
    signUp: async () => state,
    signOut: async () => {},
    savePreferences: async () => state.preferences!,
    members: async () => [],
    invitations: async () => [],
    directory: async () => ({ workspaces: state.workspaces, visited: [] }),
    leaveWorkspace: async () => {},
    createInvitation: async () => {
      throw new Error("not stubbed");
    },
    revokeInvitation: async () => {},
    setMemberRole: async () => {},
    removeMember: async () => {},
    previewInvitation: async () => {
      throw new Error("not stubbed");
    },
    acceptInvitation: async () => {
      throw new Error("not stubbed");
    },
    claimWorkspace: async () => {
      throw new Error("not stubbed");
    },
  } as unknown as AuthApi;
}
