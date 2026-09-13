import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthError } from "../auth-api";
import { useAuth } from "../auth-context";
import { Button } from "./ui/button";
import { ErrorText } from "./ui/misc";

export function AccountControl({ signInNext }: { signInNext?: string } = {}) {
  const { account, signOut } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!account) return null;

  async function leave() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await signOut();
      navigate(signInNext ? `/signin?next=${encodeURIComponent(signInNext)}` : "/signin", { replace: true });
    } catch (error) {
      setFailure(error instanceof AuthError ? error.message : "Could not sign out. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex min-w-0 flex-wrap items-center justify-end gap-2" aria-busy={busy}>
    <span className="max-w-40 truncate text-xs text-muted-foreground" title={account.displayName}>
      @{account.displayName}
    </span>
    <Button variant="ghost" className="min-h-11" disabled={busy} onClick={() => void leave()}>
      {busy ? "Signing out…" : "Sign out"}
    </Button>
    {failure && <ErrorText role="alert" className="w-full text-right">{failure}</ErrorText>}
  </div>;
}
