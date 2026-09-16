import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Clock3,
  Crown,
  Eye,
  LayoutGrid,
  ListChecks,
  Plus,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Membership, VisitedWorkspace } from "@app/contracts";
import { useAuth } from "../auth-context";
import { apiMessage } from "../workspace-api";
import { cn, relativeTime } from "../lib/utils";
import { Wordmark } from "../components/Logo";
import { ThemeToggle } from "../components/ThemeToggle";
import { AccountMenu } from "../components/AccountMenu";
import { EmptyState } from "../components/EmptyState";
import { Badge, Dot, type BadgeProps } from "../components/ui/badge";
import { Button, ButtonLink } from "../components/ui/button";
import { Input } from "../components/ui/field";
import { ErrorText, Eyebrow, Skeleton } from "../components/ui/misc";

/**
 * Where a signed-in person lands: every workspace they can get back to.
 *
 * This page is the point of accounts. Before it, a workspace lived in whichever
 * browser tab or chat message still had the URL — the data was always on the
 * server, but the way back to it was not, so losing the link lost the room.
 * Here the list comes from membership and from a record of what this account
 * has opened, which means it is the same on a phone as on a laptop and cannot
 * be mislaid.
 *
 * The page reads top to bottom in the order somebody actually wants things:
 *
 *   **Pick up where you left off** — the workspace this account was last in,
 *   drawn large, beside a short summary of everything they belong to. Offered,
 *   never performed: a redirect would take the choice away from somebody who
 *   came here to open a different one.
 *
 *   **Your workspaces** — membership as a grid of cards, most recently active
 *   first. Activity order, not alphabetical: the one you want is nearly always
 *   the one something happened in most recently. The grid ends with a tile for
 *   making another, so the list always has somewhere to grow.
 *
 *   **Opened by link** — workspaces this account has visited without being a
 *   member. Marked read-only, because that is what they are; the list restores
 *   the address, never the access.
 *
 *   **Archived** — put away, still readable, out of the way.
 *
 * The surface is the same one the landing page and the create form stand on —
 * the faint grid, the navy bloom, cards that lift on hover — so signing in
 * lands somebody in the product they were just looking at, not a plainer one.
 */
export function Home() {
  const { account, api, preferences } = useAuth();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Membership[] | null>(null);
  const [visited, setVisited] = useState<VisitedWorkspace[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    document.title = "Your workspaces — CoFlow";
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const directory = await api.directory(controller.signal);
        if (controller.signal.aborted) return;
        setWorkspaces(directory.workspaces);
        setVisited(directory.visited);
        setFailure(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        // Keep whatever is on screen. A failed refresh is a reason to say so,
        // not a reason to tell somebody they have no workspaces.
        setWorkspaces((current) => current ?? []);
        setFailure(apiMessage(error));
      }
    })();
    return () => controller.abort();
  }, [api, nonce]);

  const match = filter.trim().toLowerCase();
  const matches = useCallback(
    (name: string) => !match || name.toLowerCase().includes(match),
    [match],
  );

  // Everything current, before the filter: the summary counts what you have,
  // not what you happen to be searching for.
  const current = useMemo(
    () => (workspaces ?? []).filter((item) => !item.archived),
    [workspaces],
  );
  const active = useMemo(
    () => current.filter((item) => matches(item.name)),
    [current, matches],
  );
  const archived = useMemo(
    () => (workspaces ?? []).filter((item) => item.archived && matches(item.name)),
    [workspaces, matches],
  );
  const links = useMemo(
    () => visited.filter((item) => matches(item.name)),
    [visited, matches],
  );

  // Where this account was last working, if it is still one of theirs. Offered
  // rather than performed: a redirect would take the choice away from somebody
  // who came here to open a different one.
  const resume = active.find(
    (item) => item.workspaceId === preferences?.lastWorkspace,
  );

  const loading = workspaces === null;
  const everything = active.length + archived.length + links.length;

  return (
    <main className="relative min-h-screen overflow-x-clip">
      <Backdrop />

      <div className="mx-auto w-full max-w-6xl px-6 pb-20">
        <header className="flex items-center justify-between gap-4 py-6">
          <Link to="/" aria-label="CoFlow home" className="rounded-lg">
            <Wordmark size="lg" />
          </Link>
          <div className="flex items-center gap-2.5">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>

        <div className="mt-6 flex flex-col gap-5 animate-rise sm:mt-8 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-3">
            <Eyebrow className="flex items-center gap-1.5">
              <CalendarDays aria-hidden="true" className="size-3.5" />
              {dateline()}
            </Eyebrow>
            <h1 className="text-[32px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[40px]">
              {account
                ? `Welcome back, ${firstName(account.displayName)}`
                : "Your workspaces"}
            </h1>
            <p className="max-w-lg text-[14px] text-muted-foreground text-pretty">
              Everywhere you collaborate, on every device you sign in from.
            </p>
          </div>
          <ButtonLink variant="primary" to="/new" className="shrink-0">
            <Plus aria-hidden="true" />
            New workspace
          </ButtonLink>
        </div>

        {failure && (
          <ErrorText role="alert" className="mt-5">
            {failure}{" "}
            <button type="button" className="underline underline-offset-2" onClick={reload}>
              Try again
            </button>
          </ErrorText>
        )}

        {loading ? (
          <LoadingLayout />
        ) : everything === 0 ? (
          <EmptyState
            icon={LayoutGrid}
            className="mt-10"
            title={match ? "Nothing matches that" : "No workspaces yet"}
            action={
              match ? (
                <Button onClick={() => setFilter("")}>Clear the filter</Button>
              ) : (
                <Button variant="primary" onClick={() => navigate("/new")}>
                  <Plus aria-hidden="true" />
                  Create your first workspace
                </Button>
              )
            }
          >
            {match
              ? "No workspace you belong to or have opened has that in its name."
              : "A workspace is a shared room for one piece of work: the people, the files, the discussion, and the agents that help. Create one, then invite whoever should be in it."}
          </EmptyState>
        ) : (
          <>
            {/*
              The top row is a small bento: the place to go back to, drawn
              large, and beside it the shape of everything else. Without a
              place to go back to, the summary takes the whole row.
            */}
            {(resume || current.length > 0) && (
              <div
                className={cn(
                  "mt-8 grid gap-4 animate-rise [animation-delay:60ms]",
                  resume && "lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,1fr)]",
                )}
              >
                {resume && <ResumeCard workspace={resume} />}
                {current.length > 0 && (
                  <Summary workspaces={current} stacked={Boolean(resume)} />
                )}
              </div>
            )}

            {/* Only worth the space once the list is long enough to scan. */}
            {everything > 5 && (
              <div className="relative mt-10 max-w-md">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  className="pl-9"
                  placeholder="Find a workspace"
                  aria-label="Find a workspace"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
            )}

            <div className="mt-10 space-y-12 animate-rise [animation-delay:120ms]">
              <Section
                title="Your workspaces"
                count={active.length}
                hidden={active.length === 0}
                columns="cards"
              >
                {active.map((workspace) => (
                  <WorkspaceCard key={workspace.workspaceId} workspace={workspace} />
                ))}
                <NewWorkspaceTile />
              </Section>

              <Section
                title="Opened by link"
                count={links.length}
                hidden={links.length === 0}
                note="You can read these. Ask a host for an invitation to take part."
                columns="rows"
              >
                {links.map((workspace) => (
                  <Row
                    key={workspace.workspaceId}
                    to={`/w/${workspace.workspaceId}`}
                    name={workspace.name}
                    meta={
                      <>
                        <Badge size="sm" tone="neutral">
                          <Eye aria-hidden="true" className="size-3" />
                          View only
                        </Badge>
                        <Timestamp label="Opened" value={workspace.lastSeenAt} />
                      </>
                    }
                  />
                ))}
              </Section>

              <Section
                title="Archived"
                count={archived.length}
                hidden={archived.length === 0}
                note="Read-only, and everything is still here. A host can restore one from its settings."
                columns="rows"
              >
                {archived.map((workspace) => (
                  <Row
                    key={workspace.workspaceId}
                    to={`/w/${workspace.workspaceId}`}
                    name={workspace.name}
                    meta={
                      <>
                        <Badge size="sm" tone="neutral">
                          <Archive aria-hidden="true" className="size-3" />
                          Archived
                        </Badge>
                        <Timestamp label="Last active" value={workspace.lastActivityAt} />
                      </>
                    }
                  />
                ))}
              </Section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------- chrome */

/**
 * The same ground the landing page and the create form stand on: a faint
 * grid fading out below the fold and a soft navy bloom behind the heading.
 */
function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-x-0 top-0 h-[720px] cf-grid-backdrop opacity-50" />
      <div className="absolute -top-48 left-1/2 size-[760px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,var(--color-navy-200)_0%,transparent_62%)] opacity-50 blur-3xl dark:bg-[radial-gradient(circle,var(--color-navy-700)_0%,transparent_62%)] dark:opacity-35" />
    </div>
  );
}

/** Reserves the finished layout's shape so nothing jumps when the list lands. */
function LoadingLayout() {
  return (
    <div aria-busy="true" className="mt-8">
      <p role="status" className="sr-only">
        Loading your workspaces…
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,1fr)]">
        <Skeleton className="h-[212px] rounded-2xl" />
        <Skeleton className="h-[212px] rounded-2xl" />
      </div>
      <Skeleton className="mt-10 h-3.5 w-36" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-[176px] rounded-2xl" />
        <Skeleton className="h-[176px] rounded-2xl" />
        <Skeleton className="h-[176px] rounded-2xl" />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- top row */

/**
 * The workspace this account was last in, drawn as the page's one spotlight.
 *
 * The glow follows the pointer — a navy wash centred wherever the cursor is,
 * written straight to a CSS variable so tracking it never re-renders React.
 * It is decoration on top of an ordinary link: keyboard users get the same
 * lift and border the other cards have, and nothing depends on the glow.
 */
function ResumeCard({ workspace }: { workspace: Membership }) {
  const surface = useRef<HTMLAnchorElement>(null);
  const open = workspace.openTaskCount ?? 0;
  const pulse = recency(workspace.lastActivityAt);

  const track = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const node = surface.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    node.style.setProperty("--x", `${event.clientX - box.left}px`);
    node.style.setProperty("--y", `${event.clientY - box.top}px`);
  };

  return (
    <Link
      ref={surface}
      to={`/w/${workspace.workspaceId}`}
      onMouseMove={track}
      className="group relative isolate flex flex-col overflow-hidden rounded-2xl border border-navy-200 bg-card p-6 shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:border-navy-300 hover:shadow-md sm:p-7 dark:border-navy-800 dark:hover:border-navy-600"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(440px circle at var(--x, 70%) var(--y, 30%), color-mix(in oklab, var(--color-navy-400) 22%, transparent), transparent 65%)",
        }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-20 -right-20 -z-10 size-56 rounded-full bg-navy-200/50 blur-3xl dark:bg-navy-700/30"
      />

      <span className="flex items-center justify-between gap-3">
        <Eyebrow className="text-navy-700 dark:text-navy-300">
          Pick up where you left off
        </Eyebrow>
        {workspace.role === "owner" && (
          <Badge size="sm" tone="brand">
            <Crown aria-hidden="true" className="size-3" />
            Host
          </Badge>
        )}
      </span>

      <span className="mt-5 flex items-center gap-4">
        <Monogram name={workspace.name} size="lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-[22px] leading-tight font-semibold tracking-[-0.02em] sm:text-[26px]">
            {workspace.name}
          </span>
          <span className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Dot tone={pulse.tone} live={pulse.live} />
            <Timestamp label="Active" value={workspace.lastActivityAt} icon={false} />
          </span>
        </span>
      </span>

      <span className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-border/70 pt-5">
        <span className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          {workspace.memberCount !== undefined && (
            <Fact icon={Users}>
              {workspace.memberCount === 1
                ? "Just you"
                : `${workspace.memberCount} people`}
            </Fact>
          )}
          <Fact icon={ListChecks}>
            {open === 0 ? "No open tasks" : `${open} open ${open === 1 ? "task" : "tasks"}`}
          </Fact>
        </span>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-navy-700 dark:text-navy-300">
          Open workspace
          <ArrowRight
            aria-hidden="true"
            className="size-4 transition-transform duration-150 group-hover:translate-x-0.5"
          />
        </span>
      </span>
    </Link>
  );
}

/**
 * The shape of everything this account belongs to, in three numbers. Each is
 * read straight off the memberships already on the page — nothing is fetched
 * for it, and nothing here is an estimate.
 */
function Summary({
  workspaces,
  stacked,
}: {
  workspaces: Membership[];
  stacked: boolean;
}) {
  const openTasks = workspaces.reduce((sum, item) => sum + (item.openTaskCount ?? 0), 0);
  const hosting = workspaces.filter((item) => item.role === "owner").length;
  const figures: { icon: LucideIcon; label: string; value: number; hint: string }[] = [
    {
      icon: LayoutGrid,
      label: workspaces.length === 1 ? "Workspace" : "Workspaces",
      value: workspaces.length,
      hint: "you belong to",
    },
    {
      icon: ListChecks,
      label: openTasks === 1 ? "Open task" : "Open tasks",
      value: openTasks,
      hint: "across all of them",
    },
    {
      icon: Crown,
      label: "Hosted by you",
      value: hosting,
      hint: hosting === 1 ? "as the workspace's host" : "as their host",
    },
  ];

  return (
    <section
      aria-label="At a glance"
      className={cn(
        "grid overflow-hidden rounded-2xl border border-border bg-card shadow-xs",
        stacked
          ? "grid-cols-1 divide-y divide-border/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0 lg:grid-cols-1 lg:divide-x-0 lg:divide-y"
          : "grid-cols-1 divide-y divide-border/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0",
      )}
    >
      {figures.map(({ icon: Icon, label, value, hint }) => (
        <div
          key={label}
          className={cn(
            "flex items-center gap-4 px-5",
            stacked ? "py-4 sm:py-5 lg:py-4" : "py-5",
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-xl border border-navy-200/70 bg-navy-50 text-navy-700 dark:border-navy-800 dark:bg-navy-950/60 dark:text-navy-300"
          >
            <Icon className="size-[18px]" />
          </span>
          <span className="min-w-0">
            <span className="block font-display text-[24px] leading-none font-semibold tracking-[-0.02em] tabular-nums">
              {value}
            </span>
            <span className="mt-1 block truncate text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground/80">{label}</span> {hint}
            </span>
          </span>
        </div>
      ))}
    </section>
  );
}

/* --------------------------------------------------------------- sections */

function Section({
  title,
  count,
  note,
  hidden,
  columns,
  children,
}: {
  title: string;
  count: number;
  note?: string;
  hidden: boolean;
  /** Full cards for the workspaces you work in; tighter rows for the rest. */
  columns: "cards" | "rows";
  children: ReactNode;
}) {
  if (hidden) return null;
  return (
    <section>
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          {title}
        </h2>
        <span className="rounded-full border border-border bg-card px-1.5 py-px text-[10.5px] font-medium text-muted-foreground tabular-nums shadow-xs">
          {count}
        </span>
      </div>
      {note && <p className="mt-2 text-[12.5px] text-muted-foreground">{note}</p>}
      <ul
        className={cn(
          "mt-4 grid gap-4",
          columns === "cards" ? "sm:grid-cols-2 lg:grid-cols-3" : "gap-3 sm:grid-cols-2",
        )}
      >
        {children}
      </ul>
    </section>
  );
}

/** A workspace you work in: the card the page is made of. */
function WorkspaceCard({ workspace }: { workspace: Membership }) {
  const open = workspace.openTaskCount ?? 0;
  const pulse = recency(workspace.lastActivityAt);
  return (
    <li className="min-w-0">
      <Link
        to={`/w/${workspace.workspaceId}`}
        className="group flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:border-navy-300 hover:shadow-md dark:hover:border-navy-600"
      >
        <span className="flex items-start justify-between gap-3">
          <Monogram name={workspace.name} />
          <ArrowUpRight
            aria-hidden="true"
            className="size-4 -translate-x-1 translate-y-1 text-muted-foreground opacity-0 transition-[opacity,translate] duration-150 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:translate-y-0 group-focus-visible:opacity-100"
          />
        </span>

        <span className="mt-4 flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold tracking-tight">
            {workspace.name}
          </span>
          {workspace.role === "owner" && (
            <Badge size="sm" tone="brand" className="shrink-0">
              Host
            </Badge>
          )}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Dot tone={pulse.tone} live={pulse.live} />
          <Timestamp label="Active" value={workspace.lastActivityAt} icon={false} />
        </span>

        <span className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/70 pt-4 text-[12px] text-muted-foreground">
          {workspace.memberCount !== undefined && (
            <Fact icon={Users}>
              {workspace.memberCount === 1
                ? "Just you"
                : `${workspace.memberCount} people`}
            </Fact>
          )}
          <Fact icon={ListChecks}>
            {open === 0 ? "No open tasks" : `${open} open ${open === 1 ? "task" : "tasks"}`}
          </Fact>
        </span>
      </Link>
    </li>
  );
}

/** The grid's last tile: somewhere for the list to grow. */
function NewWorkspaceTile() {
  return (
    <li className="min-w-0">
      <Link
        to="/new"
        className="group flex h-full min-h-[176px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-card/40 p-5 text-center transition-all duration-150 hover:-translate-y-0.5 hover:border-navy-300 hover:bg-card dark:hover:border-navy-600"
      >
        <span
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-xl border border-border bg-muted text-muted-foreground transition-colors group-hover:border-navy-200 group-hover:bg-navy-50 group-hover:text-navy-700 dark:group-hover:border-navy-800 dark:group-hover:bg-navy-950/60 dark:group-hover:text-navy-300"
        >
          <Plus className="size-[18px]" />
        </span>
        <span className="text-[13.5px] font-medium">New workspace</span>
        <span className="text-[12px] text-muted-foreground">
          A shared room for one piece of work
        </span>
      </Link>
    </li>
  );
}

/** A quieter row for workspaces you can read but do not work in. */
function Row({ to, name, meta }: { to: string; name: string; meta: ReactNode }) {
  return (
    <li className="min-w-0">
      <Link
        to={to}
        className="group flex items-center gap-3.5 rounded-xl border border-border bg-card/70 p-3.5 shadow-xs transition-all duration-150 hover:-translate-y-px hover:border-navy-300 hover:bg-card dark:hover:border-navy-600"
      >
        <Monogram name={name} muted />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            {meta}
          </span>
        </span>
        <ArrowRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5"
        />
      </Link>
    </li>
  );
}

/* ------------------------------------------------------------------ atoms */

function Monogram({
  name,
  size = "default",
  muted = false,
}: {
  name: string;
  size?: "default" | "lg";
  muted?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center font-display font-semibold",
        size === "lg" ? "size-14 rounded-2xl text-[20px]" : "size-10 rounded-xl text-[14px]",
        muted
          ? "border border-border bg-muted text-muted-foreground"
          : "bg-gradient-to-br from-navy-700 to-navy-900 text-white shadow-xs dark:from-navy-100 dark:to-navy-300 dark:text-navy-900",
      )}
    >
      {monogram(name)}
    </span>
  );
}

/** One small fact with its icon, in a card's meta row. */
function Fact({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5" />
      {children}
    </span>
  );
}

/**
 * The machine-readable instant stays in `dateTime`; the reader gets the
 * comparison they were actually going to make.
 */
function Timestamp({
  label,
  value,
  icon = true,
}: {
  label: string;
  value: string | undefined;
  icon?: boolean;
}) {
  if (!value) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {icon && <Clock3 aria-hidden="true" className="size-3" />}
      {label}{" "}
      <time dateTime={value} title={new Date(value).toLocaleString()}>
        {relativeTime(value)}
      </time>
    </span>
  );
}

/**
 * How recently something happened in a workspace, as a dot's colour: green
 * and breathing within the hour, blue within the day, grey after that. The
 * timestamp beside it carries the actual figure; this is only the glance.
 */
function recency(value: string | undefined): {
  tone: NonNullable<BadgeProps["tone"]>;
  live: boolean;
} {
  if (!value) return { tone: "neutral", live: false };
  const hours = (Date.now() - new Date(value).getTime()) / 3_600_000;
  if (Number.isNaN(hours)) return { tone: "neutral", live: false };
  if (hours < 1) return { tone: "done", live: true };
  if (hours < 24) return { tone: "info", live: false };
  return { tone: "neutral", live: false };
}

/** "Good evening · Tuesday, 15 September", in the reader's own locale. */
function dateline(now = new Date()): string {
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return `${greeting} · ${date}`;
}

function monogram(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? "W";
}

function firstName(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0];
  // An address is not a greeting: "Welcome back, ada@example.com" reads as a
  // form letter, so fall back to the local part.
  return (first?.includes("@") ? first.split("@")[0] : first) || "there";
}
