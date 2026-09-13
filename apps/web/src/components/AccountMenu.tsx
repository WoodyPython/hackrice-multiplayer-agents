import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronsUpDown, LayoutGrid, LogIn, LogOut } from "lucide-react";
import { useAuth } from "../auth-context";
import { Avatar } from "./ui/misc";
import { ButtonLink } from "./ui/button";
import { cn } from "../lib/utils";

/**
 * Who you are signed in as, and how to stop being.
 *
 * The sidebar used to show a browser-local guest name here even when an account
 * was signed in, which made the account invisible in the one place a person
 * looks for it. Names now come from the verified account when there is one, and
 * the guest label survives only where it is genuinely what is being shown: to
 * other people in a live document, where §1.3 already says a self-typed label
 * is never authority.
 *
 * Signing out is here, and only here, because it should be exactly as findable
 * as the name it belongs to and no more prominent than that.
 */
export function AccountMenu({
  className,
  /**
   * Sidebar placement, where the avatar, name and role are already drawn by
   * the shell's footer. Repeating them inside this control put the same person
   * on screen twice; here it is the trailing affordance only, the same shape
   * the guest rename control uses in that slot.
   */
  sidebar = false,
}: { className?: string; sidebar?: boolean }) {
  const { account, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!account) {
    return (
      <ButtonLink to="/signin" size="sm" className={className}>
        <LogIn aria-hidden="true" />
        Sign in
      </ButtonLink>
    );
  }

  const trigger = sidebar ? (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-haspopup="menu"
      title="Account"
      className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ChevronsUpDown aria-hidden="true" className="size-3.5" />
      <span className="sr-only">Account menu</span>
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-haspopup="menu"
      className="flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted"
    >
      <Avatar name={account.displayName} />
      <span className="hidden min-w-0 text-left leading-tight sm:block">
        <span className="block truncate text-[12px] font-medium">
          {account.displayName}
        </span>
        <span className="block truncate text-[10.5px] text-muted-foreground">
          {account.email}
        </span>
      </span>
      <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="sr-only">Account menu</span>
    </button>
  );

  return (
    <div ref={container} className={cn("relative", className)}>
      {trigger}

      {open && (
        <div
          role="menu"
          className={
            sidebar
              ? "absolute bottom-full right-0 z-50 mb-1 w-60 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
              : "absolute top-full right-0 z-50 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
          }
        >
          <p className={sidebar
            ? "truncate px-3 py-2 text-[11.5px] text-muted-foreground"
            : "truncate px-3 py-2 text-[11.5px] text-muted-foreground sm:hidden"}>
            {account.email}
          </p>
          <Link
            role="menuitem"
            to="/"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[12.5px] transition-colors hover:bg-muted"
          >
            <LayoutGrid aria-hidden="true" className="size-3.5" />
            All workspaces
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              // Home, not the sign-in page: signed out, home is the marketing
              // page, and landing on a form nobody asked for reads as an error.
              void signOut().then(() => navigate("/"));
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-muted"
          >
            <LogOut aria-hidden="true" className="size-3.5" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
