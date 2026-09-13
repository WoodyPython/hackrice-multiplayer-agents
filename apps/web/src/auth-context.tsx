import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
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
  error: string | null;
  refresh: () => Promise<void>;
  setSession: (session: SessionState) => void;
  signOut: () => Promise<void>;
  setPreferences: (patch: Partial<Preferences>) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({
  children,
  api: suppliedApi,
}: {
  children: ReactNode;
  api?: AuthApi;
}) {
  const [defaultApi] = useState(() => new AuthApi(supabaseConfig()));
  const api = suppliedApi ?? defaultApi;
  const revision = useRef(0);
  const [state, setState] = useState<SessionState>({
    account: null, workspaces: [], preferences: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setError(null);
    try {
      const session = await api.current();
      if (request === revision.current) setState(session);
    } catch (error) {
      if (request === revision.current) setError("Could not check your session. Try again.");
      throw error;
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh().catch(() => {});
    return () => { ++revision.current; };
  }, [refresh]);

  const setSession = useCallback((session: SessionState) => {
    ++revision.current;
    setState(session);
    setError(null);
    setLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    ++revision.current;
    await api.signOut();
    setSession({ account: null, workspaces: [], preferences: null });
  }, [api, setSession]);

  const setPreferences = useCallback(async (patch: Partial<Preferences>) => {
    const request = revision.current;
    // Optimistic: a theme toggle that waits for a round trip feels broken.
    setState((current) => ({
      ...current,
      preferences: { ...(current.preferences ?? { theme: "system", lastWorkspace: null }), ...patch },
    }));
    try {
      const saved = await api.savePreferences(patch);
      if (request === revision.current) {
        setState((current) => ({ ...current, preferences: saved }));
      }
    } catch {
      // Settings are a convenience; a failure here must not interrupt work.
    }
  }, [api]);

  const value = useMemo<AuthValue>(
    () => ({ ...state, api, loading, error, refresh, setSession, signOut, setPreferences }),
    [state, api, loading, error, refresh, setSession, signOut, setPreferences],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required");
  return value;
}
