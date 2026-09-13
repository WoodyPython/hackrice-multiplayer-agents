import { createContext, useContext, type ReactNode } from "react";
import { canWrite, type AccessLevel } from "@app/contracts";

/**
 * What the person reading this page may do in it.
 *
 * The server has always been the enforcement -- one `preHandler` in front of
 * every workspace route -- and it stays that way. What was missing is the other
 * half: a viewer could press New task, fill in a form, press Post, and only
 * then be told no. That is the server being right and the interface being
 * unkind; a control that cannot work should not invite the work.
 *
 * §4.6 is the rule this does NOT break: hiding a button is never the check.
 * Everything here decides what is drawn and how it explains itself. Removing
 * all of it would change nothing about who can write.
 *
 * Read-only has two quite different reasons, and they are kept apart because
 * the next step differs: a viewer needs an invitation, and an archived
 * workspace needs restoring. Telling someone the wrong one sends them to the
 * wrong person.
 */
export interface WorkspaceAccess {
  access: AccessLevel;
  archived: boolean;
  /** True when a write would be accepted. Both reasons must be clear. */
  canWrite: boolean;
  /** Null when writes are fine; otherwise why, in words a reader can act on. */
  readOnlyReason: string | null;
}

const WorkspaceAccessContext = createContext<WorkspaceAccess>({
  // A default that permits, because every screen outside a workspace -- the
  // fixture demo included -- has no membership to consult, and a default that
  // silently disabled their controls would be a worse failure than this one.
  access: "member",
  archived: false,
  canWrite: true,
  readOnlyReason: null,
});

export function WorkspaceAccessProvider({
  access,
  archived,
  children,
}: {
  access: AccessLevel;
  archived: boolean;
  children: ReactNode;
}) {
  const writable = canWrite(access) && !archived;
  const value: WorkspaceAccess = {
    access,
    archived,
    canWrite: writable,
    readOnlyReason: writable
      ? null
      : archived
        ? "This workspace is archived, so it is read-only until a host restores it."
        : "You are viewing this workspace by link. Ask a host for an invitation to take part.",
  };
  return (
    <WorkspaceAccessContext.Provider value={value}>
      {children}
    </WorkspaceAccessContext.Provider>
  );
}

export function useWorkspaceAccess(): WorkspaceAccess {
  return useContext(WorkspaceAccessContext);
}

/**
 * Props for a control that changes the workspace.
 *
 * Spread onto a button: `<Button {...writeGuard(access, "Start this task")}>`.
 * `disabled` stops the click, and `title` says why on hover -- a disabled
 * control with no explanation is the thing people file bugs about.
 *
 * `aria-disabled` is deliberately NOT used instead of `disabled`: this control
 * genuinely does nothing, and a screen reader should say so rather than
 * announce something actionable that silently fails.
 */
export function writeGuard(
  gate: WorkspaceAccess,
  action?: string,
): { disabled: boolean; title?: string } {
  if (gate.canWrite) return { disabled: false };
  return {
    disabled: true,
    title: action ? `${action} is unavailable. ${gate.readOnlyReason}` : gate.readOnlyReason!,
  };
}
