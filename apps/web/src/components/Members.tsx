import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Trash2, UserPlus } from "lucide-react";
import type { Invitation, WorkspaceMember, WorkspaceRole } from "@app/contracts";
import { useAuth } from "../auth-context";
import { apiMessage } from "../workspace-api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/field";
import { ErrorText, Notice } from "./ui/misc";

/**
 * Who is in this workspace, and how somebody else gets in.
 *
 * Owner-only, and the server says so independently -- these controls are drawn
 * for owners because showing a member buttons that always fail is unkind, not
 * because hiding them is the protection.
 *
 * The invite token is shown exactly once, at creation. Only its hash is stored,
 * so this panel cannot show it again later, and the list below deliberately
 * shows no token at all.
 */
export function Members({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}) {
  const { api, account } = useAuth();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [email, setEmail] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const list = await api.members(workspaceId, controller.signal);
        if (!controller.signal.aborted) setMembers(list);
        if (isOwner) {
          const pending = await api.invitations(workspaceId, controller.signal);
          if (!controller.signal.aborted) setInvitations(pending);
        }
      } catch (error) {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      }
    })();
    return () => controller.abort();
  }, [api, workspaceId, isOwner, nonce]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await run();
      reload();
    } catch (error) {
      setFailure(apiMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const live = invitations.filter(
    (invitation) => !invitation.acceptedAt && !invitation.revokedAt,
  );

  return (
    <section className="space-y-5">
      {failure && <ErrorText role="alert">{failure}</ErrorText>}

      <div className="rounded-xl border border-border bg-card shadow-xs">
        <header className="border-b border-border p-5">
          <h2 className="text-[15px] font-semibold tracking-tight">People</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Everyone who can open and change this workspace.
          </p>
        </header>
        <ul className="divide-y divide-border">
          {members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {member.displayName}
                  {member.userId === account?.id && (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">you</span>
                  )}
                </p>
                {member.email && (
                  <p className="truncate text-[11.5px] text-muted-foreground">
                    {member.email}
                  </p>
                )}
              </div>
              {isOwner ? (
                <>
                  <select
                    aria-label={`Role for ${member.displayName}`}
                    className="h-8 rounded-lg border border-border bg-card px-2 text-[12px]"
                    value={member.role}
                    disabled={busy}
                    onChange={(event) =>
                      void act(() =>
                        api.setMemberRole(
                          workspaceId,
                          member.userId,
                          event.target.value as WorkspaceRole,
                        ),
                      )
                    }
                  >
                    <option value="member">Member</option>
                    <option value="owner">Owner</option>
                  </select>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(() => api.removeMember(workspaceId, member.userId))}
                  >
                    <Trash2 aria-hidden="true" />
                    <span className="sr-only">Remove {member.displayName}</span>
                  </Button>
                </>
              ) : (
                <Badge size="sm">{member.role}</Badge>
              )}
            </li>
          ))}
        </ul>
      </div>

      {isOwner && (
        <div className="rounded-xl border border-border bg-card shadow-xs">
          <header className="border-b border-border p-5">
            <h2 className="text-[15px] font-semibold tracking-tight">Invite someone</h2>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Creates a single-use link that expires in a week. The workspace
              address on its own never lets anyone in.
            </p>
          </header>
          <div className="space-y-4 p-5">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="invite-email">Lock to an email (optional)</Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="ada@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <select
                  id="invite-role"
                  className="h-9 rounded-lg border border-border bg-card px-3 text-[12.5px]"
                  value={role}
                  onChange={(event) => setRole(event.target.value as WorkspaceRole)}
                >
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const created = await api.createInvitation(workspaceId, {
                      role,
                      ...(email.trim() ? { email: email.trim() } : {}),
                    });
                    setFresh(`${window.location.origin}/invite/${created.token}`);
                    setCopied(false);
                    setEmail("");
                  })
                }
              >
                <UserPlus aria-hidden="true" />
                Create invite
              </Button>
            </div>

            {fresh && (
              <Notice role="status" title="Copy this now">
                <p className="text-[12.5px]">
                  This link is shown once and cannot be recovered. Anyone who has
                  it can join as {role === "owner" ? "an owner" : "a member"}.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-card px-2.5 py-1.5 font-mono text-[11.5px]">
                    {fresh}
                  </code>
                  <Button
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(fresh);
                      setCopied(true);
                    }}
                  >
                    <Copy aria-hidden="true" />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </Notice>
            )}

            {live.length > 0 && (
              <ul className="space-y-2">
                {live.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12.5px]"
                  >
                    <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {invitation.email ?? "Anyone with the link"}
                    </span>
                    <Badge size="sm">{invitation.role}</Badge>
                    <small className="text-[11px] text-muted-foreground">
                      expires {new Date(invitation.expiresAt).toLocaleDateString()}
                    </small>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api.revokeInvitation(workspaceId, invitation.id))
                      }
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
