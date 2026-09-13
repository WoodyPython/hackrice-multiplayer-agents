import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import type { Preferences, SessionState } from "@app/contracts";
import { AuthApi, supabaseConfig } from "./auth-api";

/**
 * The signed-in account, its workspaces, and its settings.
 *
 * Loaded once at startup from a single `GET /api/auth/session`, so the app
 * never renders a half-known session -- "signed in but we do not know your
 * workspaces yet" is a state that produces flicker and wrong redirects.
 *
 * `loading` is distinct from "signed out" on purpose. Treating the two as one
 * is how a refresh briefly throws a signed-in person back to the sign-in page.
 */

interface AuthValue extends SessionState {
  api: AuthApi;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  setPreferences: (patch: Partial<Preferences>) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({
  children,
  api = new AuthApi(supabaseConfig()),
}: {
  children: ReactNode;
  api?: AuthApi;
}) {
  const [state, setState] = useState<SessionState>({
    account: null, workspaces: [], preferences: null,
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setState(await api.current());
    } catch {
      // A failed read is not proof of being signed out, but it is all we know;
      // the next action will surface a real error with a real message.
      setState({ account: null, workspaces: [], preferences: null });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.signOut();
    setState({ account: null, workspaces: [], preferences: null });
  }, [api]);

  const setPreferences = useCallback(async (patch: Partial<Preferences>) => {
    // Optimistic: a theme toggle that waits for a round trip feels broken.
    setState((current) => ({
      ...current,
      preferences: { ...(current.preferences ?? { theme: "system", lastWorkspace: null }), ...patch },
    }));
    try {
      const saved = await api.savePreferences(patch);
      setState((current) => ({ ...current, preferences: saved }));
    } catch {
      // Settings are a convenience; a failure here must not interrupt work.
    }
  }, [api]);

  const value = useMemo<AuthValue>(
    () => ({ ...state, api, loading, refresh, signOut, setPreferences }),
    [state, api, loading, refresh, signOut, setPreferences],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required");
  return value;
}
