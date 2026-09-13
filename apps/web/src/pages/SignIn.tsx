import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MailCheck } from "lucide-react";
import { AuthError } from "../auth-api";
import { useAuth } from "../auth-context";
import { Wordmark } from "../components/Logo";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/field";
import { ErrorText, Notice } from "../components/ui/misc";

/**
 * Sign in or create an account.
 *
 * One screen with two modes rather than two routes: the commonest mistake here
 * is arriving at the wrong one, and a toggle costs nothing.
 *
 * Passwords go to Supabase directly and never reach our server, so nothing in
 * this file stores or forwards one. The only thing kept afterwards is the
 * HttpOnly session cookie the server sets, which this code cannot read.
 */
export function SignIn() {
  const { api, setSession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const [mode, setMode] = useState<"in" | "up">(
    params.get("mode") === "up" ? "up" : "in",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setConfirm(false);
    try {
      if (mode === "in") {
        setSession(await api.signIn(email, password));
      } else {
        const session = await api.signUp(email, password, displayName || email);
        if (!session) {
          // The project requires email confirmation. Saying so plainly beats
          // leaving someone on a form that looked like it worked.
          setConfirm(true);
          return;
        }
        setSession(session);
      }
      navigate(next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/", { replace: true });
    } catch (error) {
      setFailure(
        error instanceof AuthError
          ? error.message
          : "Something went wrong. Try again.",
      );
      if (error instanceof AuthError && error.needsConfirmation) setConfirm(true);
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

        {confirm && (
          <Notice role="status" className="mt-4" title="Check your email">
            <p className="flex items-start gap-2">
              <MailCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                We sent a confirmation link to {email || "your address"}. Open it,
                then sign in here.
              </span>
            </p>
          </Notice>
        )}

        <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
          {mode === "up" && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                autoComplete="name"
                value={displayName}
                placeholder="Ada Lovelace"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
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
              setConfirm(false);
            }}
          >
            {mode === "in" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </main>
  );
}
