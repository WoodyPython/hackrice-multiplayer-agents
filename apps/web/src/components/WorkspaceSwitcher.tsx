import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronsUpDown, LayoutGrid, Plus } from "lucide-react";
import type { Membership } from "@app/contracts";
import { cn } from "../lib/utils";

/**
 * Every workspace this account belongs to, one click away.
 *
 * The point of accounts: before this, moving between two teams meant finding
 * two different URLs, and losing one of them meant losing the workspace. Now
 * the list comes from membership, so it is the same on every device and cannot
 * be mislaid.
 *
 * It renders as a menu button rather than a list because the sidebar is for the
 * current workspace -- switching is an occasional act, not a constant one.
 */
export function WorkspaceSwitcher({
  workspaces,
  currentId,
  currentName,
  onNavigate,
}: {
  workspaces: Membership[];
  currentId: string | undefined;
  currentName: string;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const current = workspaces.find((item) => item.workspaceId === currentId);
  /*
    Archived workspaces are deliberately not offered here. The switcher is for
    moving between the places you are working; an archived one is read-only and
    reachable from the home page, which is where putting-things-away lives.
    The one exception is the archived workspace you are looking at right now --
    hiding the current entry would make the button describe nothing.
  */
  const options = workspaces.filter(
    (item) => !item.archived || item.workspaceId === currentId,
  );

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/10"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-white">
            {current?.name ?? currentName}
          </span>
          <span className="block truncate text-[11px] text-white/60">
            {current
              ? current.archived
                ? "Archived"
                : current.role === "owner"
                  ? "Owner"
                  : "Member"
              : "Viewing by link"}
          </span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-white/60" />
        <span className="sr-only">Switch workspace</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
        >
          {options.length === 0 && (
            <p className="px-3 py-2.5 text-[12px] text-muted-foreground">
              You are not a member of any workspace yet.
            </p>
          )}
          {options.map((workspace) => (
            <Link
              key={workspace.workspaceId}
              role="menuitem"
              to={`/w/${workspace.workspaceId}`}
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-[12.5px] transition-colors hover:bg-muted",
                workspace.workspaceId === currentId && "font-medium",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              {workspace.role === "owner" && (
                <span className="shrink-0 text-[10.5px] text-muted-foreground">
                  owner
                </span>
              )}
              {workspace.workspaceId === currentId && (
                <Check aria-hidden="true" className="size-3.5 shrink-0" />
              )}
            </Link>
          ))}
          <div className="mt-1 border-t border-border pt-1">
            <Link
              role="menuitem"
              to="/"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2 px-3 py-2 text-[12.5px] transition-colors hover:bg-muted"
            >
              <LayoutGrid aria-hidden="true" className="size-3.5" />
              All workspaces
            </Link>
            <Link
              role="menuitem"
              to="/new"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2 px-3 py-2 text-[12.5px] transition-colors hover:bg-muted"
            >
              <Plus aria-hidden="true" className="size-3.5" />
              New workspace
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
