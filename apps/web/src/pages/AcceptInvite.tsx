import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, type InvitationPreview } from "@app/contracts";
import { useAuth } from "../auth-context";
import { Wordmark } from "../components/Logo";
import { AccountControl } from "../components/AccountControl";
import { Button, ButtonLink } from "../components/ui/button";
import { ErrorText, Notice, Skeleton } from "../components/ui/misc";

/**
 * Accepting an invitation.
 *
 * The token in this URL is the credential, not the workspace address, so the
 * page shows what is being joined before anything is accepted and refuses
 * politely when the token is spent, expired, revoked, or issued to somebody
 * else's address.
 *
 * A signed-out visitor is sent to sign in and returned here afterwards, rather
 * than losing the invitation on the way.
 */
export function AcceptInvite() {
  const { token = "" } = useParams();
  const { api, account, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [acceptFailure, setAcceptFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token || loading) return;
    const controller = new AbortController();
    setPreview(null);
    setFailure(null);
    setAcceptFailure(null);
    void api
      .previewInvitation(token, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(
          error instanceof ApiError && error.code === "INVITATION_INVALID"
            ? "This invitation is no longer valid. It may have been used already, expired, or been withdrawn."
            : "Could not read this invitation.",
        );
      });
    return () => controller.abort();
  }, [api, token, account?.id, loading, retry]);

  async function accept() {
    setBusy(true);
    setAcceptFailure(null);
    try {
      const membership = await api.acceptInvitation(token);
      // Acceptance is committed already. A failed account refresh must not
      // invite a second submission of a now-consumed invitation.
      await refresh().catch(() => {});
      navigate(`/w/${membership.workspaceId}`, { replace: true });
    } catch (error) {
      setAcceptFailure(
        error instanceof ApiError && error.code === "INVITATION_INVALID"
          ? "This invitation is no longer valid, or it was issued to a different email address."
          : "Could not accept the invitation. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col justify-center px-6 py-16">
      <Wordmark size="lg" className="mb-8 self-center" />
      <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
        {loading || (!preview && !failure) ? (
          <div aria-busy="true" className="space-y-3">
            <p role="status" className="sr-only">
              Opening invitation…
            </p>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-16" />
          </div>
        ) : failure ? (
          <>
            <h1 className="text-lg font-semibold tracking-tight">
              This invitation cannot be used
            </h1>
            <ErrorText role="alert" className="mt-2">
              {failure}
            </ErrorText>
            <p className="mt-3 text-[12.5px] text-muted-foreground">
              Ask whoever invited you to send a new one.
            </p>
            <Button onClick={() => setRetry((value) => value + 1)} className="mt-5 w-full">
              Try again
            </Button>
            <ButtonLink to="/" className="mt-5 w-full">
              Go to CoFlow
            </ButtonLink>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold tracking-tight">
              Join {preview!.workspaceName}
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              You have been invited as {preview!.role === "owner" ? "an owner" : "a member"}.
            </p>

            {preview!.emailMismatch && (
              <Notice role="alert" tone="warn" className="mt-4" title="Different email address">
                <p>
                  This invitation was issued to a specific address, and it is not
                  the one you are signed in with. Sign in with the invited
                  address, or ask for a new invitation.
                </p>
                <AccountControl signInNext={`/invite/${token}`} />
              </Notice>
            )}

            {account ? (
              <>
                {acceptFailure && <ErrorText role="alert" className="mt-4">{acceptFailure}</ErrorText>}
                <Button
                  variant="primary"
                  className="mt-5 w-full"
                  disabled={busy || preview!.emailMismatch}
                  onClick={() => void accept()}
                >
                  {busy ? "Joining…" : `Join as ${account.displayName}`}
                </Button>
              </>
            ) : (
              <>
                <p className="mt-4 text-[12.5px] text-muted-foreground">
                  Sign in or create an account to accept. We will bring you
                  straight back here.
                </p>
                <ButtonLink
                  variant="primary"
                  className="mt-4 w-full"
                  to={`/signin?next=${encodeURIComponent(`/invite/${token}`)}`}
                >
                  Continue
                </ButtonLink>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
