import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArchiveRestore, LogOut, Trash2 } from "lucide-react";
import { ApiError, type Workspace } from "@app/contracts";
import { useAuth } from "../auth-context";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/field";
import { ErrorText, Notice } from "./ui/misc";

/**
 * Putting a workspace away, leaving one, and getting rid of one.
 *
 * Three different intentions that all used to have the same answer — nothing.
 * The result was that every workspace anyone ever made stayed forever, which is
 * both clutter in a list people have to scan and storage on a database with a
 * fixed ceiling.
 *
 * They are ordered by how much they cost you if you were wrong:
 *
 *   **Leave** affects only you, and you can be invited back.
 *   **Archive** affects everyone and is reversible by any owner.
 *   **Delete** is none of those things, so it asks you to type the name.
 */
export function WorkspaceLifecycle({
  workspace,
  onChange,
}: {
  workspace: Workspace;
  onChange: (value: Workspace) => void;
}) {
  const { api } = useBrowser();
  const { api: authApi, account, refresh } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [confirming, setConfirming] = useState(false);

  const archived = workspace.status === "archived";
  const nameMatches = confirmName.trim() === workspace.name.trim();

  async function act(run: () => Promise<void>, explain?: (error: unknown) => string | undefined) {
    setBusy(true);
    setFailure(null);
    try {
      await run();
    } catch (error) {
      setFailure(explain?.(error) ?? apiMessage(error));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The one refusal here that the generic copy gets wrong.
   *
   * Leaving is refused for the last owner, and `apiMessage` would render that
   * as "you do not have permission", which is both untrue and unactionable:
   * they have the permission, and what they need to do is make somebody else an
   * owner first. Server messages are never displayed (§13.3), so the specific
   * copy has to live here.
   */
  function whyLeaveFailed(error: unknown): string | undefined {
    return error instanceof ApiError && error.code === "FORBIDDEN"
      ? "You are the only owner, so leaving would leave this workspace with nobody who can manage it. Make someone else an owner first."
      : undefined;
  }

  return (
    <section className="space-y-5">
      {failure && <ErrorText role="alert">{failure}</ErrorText>}

      {/*
        Anyone in the workspace can leave except the last owner, who cannot: a
        workspace with nobody who can administer it can never be recovered,
        invited into, archived, or deleted by anybody.

        The button is offered anyway rather than predicted away. This screen
        does not know how many owners there are, and a control that is
        sometimes missing for a reason nobody explained is worse than one that
        refuses with `whyLeaveFailed` saying what to do about it.
      */}
      {account && workspace.access !== "viewer" && (
        <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
          <h2 className="text-[15px] font-semibold tracking-tight">Leave this workspace</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            You stop being a member and it leaves your list. Nothing here is
            deleted, and an owner can invite you back.
          </p>
          <Button
            className="mt-4"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await authApi.leaveWorkspace(workspace.id);
                await refresh();
                navigate("/", { replace: true });
              }, whyLeaveFailed)
            }
          >
            <LogOut aria-hidden="true" />
            Leave workspace
          </Button>
        </div>
      )}

      {workspace.isOwner && (
        <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
          <h2 className="text-[15px] font-semibold tracking-tight">
            {archived ? "Restore this workspace" : "Archive this workspace"}
          </h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {archived
              ? "Everyone can work in it again, exactly as before."
              : "It becomes read-only for everyone and moves out of the main list. Every task, file, and discussion stays, and you can bring it back at any time."}
          </p>
          <Button
            className="mt-4"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                onChange(await api.setStatus(workspace.id, archived ? "active" : "archived"));
              })
            }
          >
            {archived ? (
              <>
                <ArchiveRestore aria-hidden="true" />
                Restore workspace
              </>
            ) : (
              <>
                <Archive aria-hidden="true" />
                Archive workspace
              </>
            )}
          </Button>
        </div>
      )}

      {workspace.isOwner && (
        <div className="rounded-xl border border-destructive/40 bg-card p-5 shadow-xs">
          <h2 className="text-[15px] font-semibold tracking-tight">Delete this workspace</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Permanent, and it takes everything with it: every task, the
            discussion, the files and their history, and the agents' work. This
            cannot be undone by us or by anyone.{" "}
            {!archived && "If you only want it out of the way, archive it instead."}
          </p>

          {!confirming ? (
            <Button
              variant="destructive"
              className="mt-4"
              disabled={busy}
              onClick={() => {
                setConfirming(true);
                setConfirmName("");
                setFailure(null);
              }}
            >
              <Trash2 aria-hidden="true" />
              Delete workspace
            </Button>
          ) : (
            <Notice role="alert" tone="warn" className="mt-4" title="This cannot be undone">
              <div className="space-y-1.5">
                <Label htmlFor="confirm-delete">
                  Type <span className="font-semibold text-foreground">{workspace.name}</span> to
                  confirm
                </Label>
                <Input
                  id="confirm-delete"
                  value={confirmName}
                  autoComplete="off"
                  onChange={(event) => setConfirmName(event.target.value)}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  // The server checks this too, and that is the real guard.
                  // Disabling here only saves a round trip and a scolding.
                  disabled={busy || !nameMatches}
                  onClick={() =>
                    void act(async () => {
                      await api.destroy(workspace.id, confirmName.trim());
                      await refresh();
                      navigate("/", { replace: true });
                    })
                  }
                >
                  {busy ? "Deleting…" : "Delete permanently"}
                </Button>
                <Button disabled={busy} onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
            </Notice>
          )}
        </div>
      )}
    </section>
  );
}
