import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  ChevronDown,
  Clock3,
  FileText,
  LayoutGrid,
  Menu,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Wordmark } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar } from "./ui/misc";
import { Badge } from "./ui/badge";

export type NavItem = {
  to: string;
  label: string;
  icon: "board" | "files" | "history" | "settings";
  end?: boolean;
  count?: number;
};

const ICONS = {
  board: LayoutGrid,
  files: FileText,
  history: Clock3,
  settings: Settings,
} as const;

function NavList({
  items,
  onNavigate,
}: {
  items: NavItem[];
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Workspace" className="grid gap-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-navy-600 transition-opacity dark:bg-navy-300",
                    isActive ? "opacity-100" : "opacity-0",
                  )}
                />
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
                {item.count !== undefined && (
                  <Badge
                    tone={isActive ? "brand" : "neutral"}
                    size="sm"
                    className="ml-auto tabular-nums"
                  >
                    {item.count}
                  </Badge>
                )}
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function WorkspaceCard({
  name,
  subtitle,
  settingsTo,
  onNavigate,
}: {
  name: string;
  subtitle: string;
  settingsTo?: string;
  onNavigate?: () => void;
}) {
  const card = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-navy-800 font-display text-[13px] font-semibold text-white dark:bg-navy-100 dark:text-navy-900"
      >
        {name.trim()[0]?.toUpperCase() ?? "W"}
      </span>
      <span className="min-w-0 flex-1 text-left leading-tight">
        <span className="block truncate text-[13px] font-semibold">{name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {subtitle}
        </span>
      </span>
    </span>
  );

  if (!settingsTo)
    return (
      <div className="rounded-xl border border-border bg-muted/40 p-2.5">
        {card}
      </div>
    );

  return (
    <details className="group rounded-xl border border-border bg-muted/40 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-2.5">
        {card}
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border p-1">
        <Link
          to={settingsTo}
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Settings className="size-3.5" aria-hidden="true" />
          Workspace settings
        </Link>
      </div>
    </details>
  );
}

function SidebarBody({
  workspaceName,
  workspaceSubtitle,
  settingsTo,
  items,
  guestName,
  guestRole,
  onNavigate,
}: {
  workspaceName: string;
  workspaceSubtitle: string;
  settingsTo?: string;
  items: NavItem[];
  guestName: string;
  guestRole: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 p-4">
      <Link
        to="/"
        onClick={onNavigate}
        className="rounded-lg px-1 py-0.5"
        aria-label="CoFlow home"
      >
        <Wordmark />
      </Link>

      <WorkspaceCard
        name={workspaceName}
        subtitle={workspaceSubtitle}
        settingsTo={settingsTo}
        onNavigate={onNavigate}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-2 px-3 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Workspace
        </p>
        <NavList items={items} onNavigate={onNavigate} />
      </div>

      <div className="grid gap-3">
        <div className="rounded-xl border border-navy-200/70 bg-navy-50/60 p-3.5 dark:border-navy-800 dark:bg-navy-950/40">
          <Sparkles
            aria-hidden="true"
            className="size-4 text-navy-600 dark:text-navy-300"
          />
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            Plan together, let agents help, and review the result. You decide
            when it is done.
          </p>
        </div>
        <div className="flex items-center gap-2.5 px-1">
          <Avatar name={guestName} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[12px] font-medium">
              {guestName}
            </span>
            <span className="block text-[10.5px] text-muted-foreground">
              {guestRole}
            </span>
          </span>
        </div>

      </div>
    </div>
  );
}

/**
 * The workspace chrome: a fixed sidebar on desktop, a slide-over on small
 * screens, and a sticky topbar over the scrolling content.
 *
 * Both the live workspace and the fixture demo render through this, so the two
 * cannot drift apart — the demo's differences arrive as `strip` and `topbarEnd`
 * rather than as a second copy of the layout.
 */
export function AppShell({
  workspaceName,
  workspaceSubtitle = "Shared workspace",
  settingsTo,
  items,
  guestName,
  guestRole,
  breadcrumb,
  topbarEnd,
  strip,
  children,
}: {
  workspaceName: string;
  workspaceSubtitle?: string;
  settingsTo?: string;
  items: NavItem[];
  guestName: string;
  guestRole: string;
  breadcrumb: ReactNode;
  topbarEnd?: ReactNode;
  strip?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) =>
      event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);

  const sidebar = (onNavigate?: () => void) => (
    <SidebarBody
      workspaceName={workspaceName}
      workspaceSubtitle={workspaceSubtitle}
      settingsTo={settingsTo}
      items={items}
      guestName={guestName}
      guestRole={guestRole}
      onNavigate={onNavigate}
    />
  );

  return (
    <div className="flex min-h-screen bg-background">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2.5 focus:text-[13px] focus:font-medium focus:shadow-lg"
        href="#main"
      >
        Skip to content
      </a>

      <div className="hidden w-[264px] shrink-0 border-r border-border bg-card lg:block">
        <aside className="sticky top-0 h-screen">{sidebar()}</aside>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-navy-950/40 backdrop-blur-[2px] animate-[fade_0.25s_ease-out_both]"
          />
          <div className="absolute inset-y-0 left-0 w-[280px] max-w-[86vw] border-r border-border bg-card shadow-lg animate-[fade_0.25s_ease-out_both]">
            {sidebar(() => setOpen(false))}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center gap-3 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur-md sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            {open ? (
              <X className="size-4" aria-hidden="true" />
            ) : (
              <Menu className="size-4" aria-hidden="true" />
            )}
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-muted-foreground">
            {breadcrumb}
          </div>
          <ThemeToggle />
          {topbarEnd}
        </header>

        {strip}

        <main
          id="main"
          tabIndex={-1}
          className="flex-1 px-4 py-7 outline-none sm:px-6 sm:py-9 lg:px-8 xl:px-10"
        >
          <div className="mx-auto w-full max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** `Workspace / Name` breadcrumb, shared by the live and demo topbars. */
export function Breadcrumb({ trail }: { trail: string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate">
      {trail.map((part, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden="true" className="text-border">
              /
            </span>
          )}
          <span
            className={cn(
              "truncate",
              index === trail.length - 1 && "font-medium text-foreground",
            )}
          >
            {part}
          </span>
        </span>
      ))}
    </span>
  );
}
