import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Archive,
  ArrowRight,
  Clock3,
  Eye,
  LayoutGrid,
  Plus,
  Search,
  Users,
} from "lucide-react";
import type { Membership, VisitedWorkspace } from "@app/contracts";
import { useAuth } from "../auth-context";
import { apiMessage } from "../workspace-api";
import { relativeTime } from "../lib/utils";
import { Wordmark } from "../components/Logo";
import { ThemeToggle } from "../components/ThemeToggle";
import { AccountMenu } from "../components/AccountMenu";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "../components/ui/badge";
import { Button, ButtonLink } from "../components/ui/button";
import { Input } from "../components/ui/field";
import { ErrorText, Skeleton } from "../components/ui/misc";

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
 * Three groups, in the order somebody actually wants them:
 *
 *   **Your workspaces** — membership, most recently active first. Activity
 *   order, not alphabetical: the one you want is nearly always the one
 *   something happened in most recently.
 *
 *   **Opened by link** — workspaces this account has visited without being a
 *   member. Marked read-only, because that is what they are; the list restores
 *   the address, never the access.
 *
 *   **Archived** — put away, still readable, out of the way.
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

  const active = useMemo(
    () => (workspaces ?? []).filter((item) => !item.archived && matches(item.name)),
    [workspaces, matches],
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
    <main className="mx-auto w-full max-w-5xl px-6 pb-20">
      <header className="flex items-center justify-between gap-4 py-6">
        <Link to="/" aria-label="CoFlow home" className="rounded-lg">
          <Wordmark size="lg" />
        </Link>
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          <AccountMenu />
        </div>
      </header>

      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.03em] sm:text-[32px]">
            {account ? `Welcome back, ${firstName(account.displayName)}` : "Your workspaces"}
          </h1>
          <p className="text-[13.5px] text-muted-foreground">
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

      {resume && (
        <Link
          to={`/w/${resume.workspaceId}`}
          className="mt-7 flex items-center gap-4 rounded-xl border border-navy-200 bg-navy-50/70 p-4 transition-colors hover:bg-navy-100/70 sm:p-5 dark:border-navy-800 dark:bg-navy-950/40 dark:hover:bg-navy-900/40"
        >
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-lg bg-navy-800 font-display text-[15px] font-semibold text-white dark:bg-navy-100 dark:text-navy-900"
          >
            {monogram(resume.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Pick up where you left off
            </span>
            <span className="mt-0.5 block truncate text-[15px] font-semibold">
              {resume.name}
            </span>
          </span>
          <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      )}

      {/* Only worth the space once the list is long enough to scan. */}
      {!loading && everything > 5 && (
        <div className="relative mt-7">
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

      {loading ? (
        <div aria-busy="true" className="mt-8 space-y-3">
          <p role="status" className="sr-only">
            Loading your workspaces…
          </p>
          <Skeleton className="h-[76px]" />
          <Skeleton className="h-[76px]" />
          <Skeleton className="h-[76px]" />
        </div>
      ) : everything === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          className="mt-8"
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
        <div className="mt-8 space-y-10">
          <Section
            title="Your workspaces"
            count={active.length}
            hidden={active.length === 0}
          >
            {active.map((workspace) => (
              <MembershipRow key={workspace.workspaceId} workspace={workspace} />
            ))}
          </Section>

          <Section
            title="Opened by link"
            count={links.length}
            hidden={links.length === 0}
            note="You can read these. Ask an owner for an invitation to take part."
          >
            {links.map((workspace) => (
              <Row
                key={workspace.workspaceId}
                to={`/w/${workspace.workspaceId}`}
                name={workspace.name}
                muted
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
            note="Read-only, and everything is still here. An owner can restore one from its settings."
          >
            {archived.map((workspace) => (
              <Row
                key={workspace.workspaceId}
                to={`/w/${workspace.workspaceId}`}
                name={workspace.name}
                muted
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
      )}
    </main>
  );
}

function Section({
  title,
  count,
  note,
  hidden,
  children,
}: {
  title: string;
  count: number;
  note?: string;
  hidden: boolean;
  children: ReactNode;
}) {
  if (hidden) return null;
  return (
    <section>
      <h2 className="flex items-baseline gap-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
        {title}
        <span className="text-[11px] font-normal tabular-nums">{count}</span>
      </h2>
      {note && <p className="mt-1.5 text-[12.5px] text-muted-foreground">{note}</p>}
      <ul className="mt-3 grid gap-2.5">{children}</ul>
    </section>
  );
}

function MembershipRow({ workspace }: { workspace: Membership }) {
  const open = workspace.openTaskCount ?? 0;
  return (
    <Row
      to={`/w/${workspace.workspaceId}`}
      name={workspace.name}
      meta={
        <>
          {workspace.role === "owner" && (
            <Badge size="sm" tone="brand">
              Owner
            </Badge>
          )}
          {workspace.memberCount !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Users aria-hidden="true" className="size-3" />
              {workspace.memberCount === 1
                ? "Just you"
                : `${workspace.memberCount} people`}
            </span>
          )}
          {open > 0 && (
            <span>
              {open} open {open === 1 ? "task" : "tasks"}
            </span>
          )}
          <Timestamp label="Active" value={workspace.lastActivityAt} />
        </>
      }
    />
  );
}

function Row({
  to,
  name,
  meta,
  muted,
}: {
  to: string;
  name: string;
  meta: ReactNode;
  muted?: boolean;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 shadow-xs transition-colors hover:bg-muted/60"
      >
        <span
          aria-hidden="true"
          className={
            muted
              ? "grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted font-display text-[13px] font-semibold text-muted-foreground"
              : "grid size-9 shrink-0 place-items-center rounded-lg bg-navy-800 font-display text-[13px] font-semibold text-white dark:bg-navy-100 dark:text-navy-900"
          }
        >
          {monogram(name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            {meta}
          </span>
        </span>
        <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

/**
 * The machine-readable instant stays in `dateTime`; the reader gets the
 * comparison they were actually going to make.
 */
function Timestamp({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Clock3 aria-hidden="true" className="size-3" />
      {label}{" "}
      <time dateTime={value} title={new Date(value).toLocaleString()}>
        {relativeTime(value)}
      </time>
    </span>
  );
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
