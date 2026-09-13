import { useState } from "react";
import { KeyRound } from "lucide-react";
import { ApiError } from "@app/contracts";
import { useAuth } from "../auth-context";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/field";
import { ErrorText, Notice } from "./ui/misc";

/**
 * Bringing a pre-accounts workspace under an account.
 *
 * Shown only for a workspace that still has a legacy owner key, to somebody
 * signed in who is not yet a member.
 *
 * The key is the proof, and nothing else is accepted. Possession of it is
 * exactly what ownership meant before accounts existed, whereas the workspace
 * address is held by everyone it was ever sent to -- honouring that would hand
 * each old workspace to whoever opened it first. On success the server clears
 * the stored hash, so a key pasted into a chat months ago stops working.
 */
export function ClaimWorkspace({
  workspaceId,
  workspaceName,
  onClaimed,
}: {
  workspaceId: string;
  workspaceName: string;
  onClaimed: () => void;
}) {
  const { api, refresh } = useAuth();
  const [ownerKey, setOwnerKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function claim() {
    setBusy(true);
    setFailure(null);
    try {
      await api.claimWorkspace(workspaceId, ownerKey.trim());
      // Ownership already changed; a failed follow-up read must not suggest
      // retrying the owner key, which has now been invalidated.
      await refresh().catch(() => {});
      onClaimed();
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.code === "OWNER_KEY_REQUIRED"
          ? "That is not this workspace's owner key."
          : error instanceof ApiError && error.code === "FORBIDDEN"
            ? "This workspace already belongs to an account. Ask one of its owners for an invitation."
            : "Could not claim this workspace. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice
      role="status"
      className="mb-6"
      title={`${workspaceName} was created before accounts existed`}
    >
      <p>
        Paste its owner key to take ownership with your account. You will not
        need the key again afterwards, and it stops working once used.
      </p>
      <form
        className="mt-3 flex flex-col gap-2.5 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void claim();
        }}
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="owner-key">Owner key</Label>
          <Input
            id="owner-key"
            value={ownerKey}
            autoComplete="off"
            spellCheck={false}
            placeholder="The key shown when the workspace was created"
            onChange={(event) => setOwnerKey(event.target.value)}
            className="font-mono text-[12px]"
          />
        </div>
        <Button variant="primary" type="submit" disabled={busy || !ownerKey.trim()}>
          <KeyRound aria-hidden="true" />
          {busy ? "Claiming…" : "Claim workspace"}
        </Button>
      </form>
      {failure && (
        <ErrorText role="alert" className="mt-2">
          {failure}
        </ErrorText>
      )}
    </Notice>
  );
}
