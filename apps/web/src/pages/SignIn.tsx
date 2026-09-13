import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthError } from "../auth-api";
import { useAuth } from "../auth-context";
import { Wordmark } from "../components/Logo";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/field";
import { ErrorText } from "../components/ui/misc";

/**
 * Sign in or create an account.
 *
 * One screen with two modes rather than two routes: the commonest mistake here
 * is arriving at the wrong one, and a toggle costs nothing.
 *
 * Sign-in passwords go directly to Supabase. Account creation goes through the
 * server so it can create an already-confirmed username identity. The browser
 * stores neither password nor provider token; it keeps only the HttpOnly
 * session cookie, which this code cannot read.
 */
export function SignIn() {
  const { api, setSession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const [mode, setMode] = useState<"in" | "up">(
    params.get("mode") === "up" ? "up" : "in",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      if (mode === "in") {
        setSession(await api.signIn(username, password));
      } else {
        setSession(await api.signUp(username, password));
      }
      navigate(next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/", { replace: true });
    } catch (error) {
      setFailure(
        error instanceof AuthError
          ? error.message
          : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col justify-center px-6 py-16">
      <Wordmark size="lg" className="mb-8 self-center" />

      <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">
          {mode === "in" ? "Sign in" : "Create your account"}
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {mode === "in"
            ? "Your workspaces are waiting."
            : "One account, as many teams as you like."}
        </p>

        <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              required
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              autoComplete="username"
              value={username}
              placeholder="ada"
              onChange={(event) => setUsername(event.target.value)}
            />
            {mode === "up" && (
              <p className="text-[11.5px] text-muted-foreground">
                3–32 characters: letters, numbers, dots, dashes, or underscores.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={mode === "up" ? 8 : undefined}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {mode === "up" && (
              <p className="text-[11.5px] text-muted-foreground">
                At least 8 characters.
              </p>
            )}
          </div>

          {failure && <ErrorText role="alert">{failure}</ErrorText>}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={busy}
          >
            {busy
              ? "Working…"
              : mode === "in"
                ? "Sign in"
                : "Create account"}
          </Button>
        </form>

        <p className="mt-5 text-center text-[12.5px] text-muted-foreground">
          {mode === "in" ? "No account yet?" : "Already have an account?"}{" "}
          <button
            type="button"
            disabled={busy}
            className="font-medium text-navy-700 underline-offset-2 hover:underline dark:text-navy-300"
            onClick={() => {
              setMode(mode === "in" ? "up" : "in");
              setFailure(null);
            }}
          >
            {mode === "in" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </main>
  );
}
