import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CircleCheck,
  ClipboardList,
  FileText,
  GitCompare,
  Lightbulb,
  ListChecks,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import {
  ApiError,
  type Briefing,
  type BriefingItem,
  type BriefingLink,
  type BriefingWindow,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageHeading } from "../components/PageHeading";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ErrorText, Notice, Skeleton } from "../components/ui/misc";

/**
 * Overview: "Catch me up".
 *
 * A briefing is generated on the server from this workspace's records and
 * checked against them before it arrives, so this screen only renders. Three
 * rules it keeps:
 *
 * - Links are built here from typed IDs, never taken from the response as URLs.
 * - Generated statements are labeled as generated; counts, open questions and
 *   reviews, and the activity recap come from records and are labeled as such.
 * - Nothing here acts. Suggested next steps are text and links to look at.
 */

const WINDOWS: { value: BriefingWindow; label: string }[] = [
  { value: "since_last", label: "Since last briefing" },
  { value: "last_hour", label: "Last hour" },
  { value: "last_24h", label: "Last 24 hours" },
];

const WINDOW_LABEL: Record<BriefingWindow, string> = {
  since_last: "Since last briefing",
  last_hour: "Last hour",
  last_24h: "Last 24 hours",
};

export function Overview({ workspaceId }: { workspaceId: string }) {
  const { api } = useBrowser();
  const [choice, setChoice] = useState<BriefingWindow>("since_last");
  const [history, setHistory] = useState<Briefing[] | null>(null);
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [shown, setShown] = useState<{ briefing: Briefing; earlier: boolean } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const base = `/w/${workspaceId}`;

  useEffect(() => {
    const request = new AbortController();
    setHistoryError(false);
    void api
      .listBriefings(workspaceId, request.signal)
      .then((result) => {
        if (request.signal.aborted) return;
        setHistory(result.briefings);
        setCutoff(result.cutoff);
      })
      .catch(() => {
        if (!request.signal.aborted) {
          setHistory((current) => current ?? []);
          setHistoryError(true);
        }
      });
    return () => request.abort();
  }, [api, workspaceId, historyNonce]);

  useEffect(() => () => controller.current?.abort(), []);

  const generate = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setGenerating(true);
    setFailure(null);
    try {
      const briefing = await api.generateBriefing(workspaceId, choice, request.signal);
      if (request.signal.aborted) return;
      setShown({ briefing, earlier: false });
      if (briefing.id) {
        setHistory((current) => [briefing, ...(current ?? []).filter((item) => item.id !== briefing.id)].slice(0, 10));
      }
      if (briefing.cutoffAdvanced) setCutoff(briefing.until);
    } catch (error) {
      if (!request.signal.aborted) setFailure(briefingError(error));
    } finally {
      if (!request.signal.aborted) setGenerating(false);
    }
  }, [api, workspaceId, choice]);

  return (
    <>
      <PageHeading
        eyebrow="Catch me up"
        title="Overview"
        description="A short briefing of what changed in this workspace, what is waiting on someone, and where to look next."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-end sm:justify-between sm:pt-6">
              <fieldset className="min-w-0 space-y-2">
                <legend className="mb-2 text-[12px] font-medium text-muted-foreground">Time window</legend>
                <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
                  {WINDOWS.map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        "cursor-pointer rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                        choice === option.value
                          ? "bg-card text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <input
                        type="radio"
                        name="briefing-window"
                        value={option.value}
                        checked={choice === option.value}
                        onChange={() => setChoice(option.value)}
                        disabled={generating}
                        className="sr-only"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                <p className="text-[12px] text-muted-foreground">
                  {windowHint(choice, cutoff, history === null)}
                </p>
              </fieldset>
              <Button
                variant="primary"
                onClick={() => void generate()}
                disabled={generating}
                aria-busy={generating}
                className="shrink-0"
              >
                <Sparkles aria-hidden="true" />
                {generating ? "Catching you up…" : "Catch me up"}
              </Button>
            </CardContent>
          </Card>

          <section aria-busy={generating} aria-label="Briefing" className="space-y-6">
            {generating ? (
              <div className="space-y-4">
                <p role="status" className="text-[13px] text-muted-foreground">
                  Reading the workspace records and writing your briefing…
                </p>
                <Skeleton aria-hidden="true" className="h-24" />
                <div aria-hidden="true" className="grid gap-4 lg:grid-cols-2">
                  <Skeleton className="h-40" />
                  <Skeleton className="h-40" />
                </div>
              </div>
            ) : failure ? (
              <Notice role="alert" tone="warn" title="The briefing could not be generated">
                <p>{failure}</p>
                <Button size="sm" onClick={() => void generate()}>
                  <RotateCcw aria-hidden="true" />
                  Try again
                </Button>
              </Notice>
            ) : shown ? (
              <BriefingView briefing={shown.briefing} base={base} fromHistory={shown.earlier} />
            ) : (
              <EmptyState icon={Sparkles} title="Ready when you are">
                Choose a time window and select Catch me up. The briefing is built only from this workspace's tasks,
                discussion, reviews, and files — nothing is changed on your behalf.
              </EmptyState>
            )}
          </section>
        </div>

        <aside aria-label="Earlier briefings" className="min-w-0">
          <Card>
            <CardHeader className="pb-3 sm:pb-3">
              <CardTitle className="text-[13.5px]">Earlier briefings</CardTitle>
              <CardDescription className="text-[12px]">Kept for this browser only.</CardDescription>
            </CardHeader>
            <CardContent>
              {history === null ? (
                <div className="space-y-2">
                  <p role="status" className="sr-only">Loading earlier briefings…</p>
                  <Skeleton aria-hidden="true" className="h-10" />
                  <Skeleton aria-hidden="true" className="h-10" />
                </div>
              ) : historyError ? (
                <div role="alert" className="space-y-2">
                  <ErrorText>Earlier briefings could not be loaded.</ErrorText>
                  <Button size="sm" onClick={() => setHistoryNonce((value) => value + 1)}>Try again</Button>
                </div>
              ) : history.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">No briefings yet. Your first one will appear here.</p>
              ) : (
                <ul className="grid gap-1.5">
                  {history.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={shown?.briefing.id === item.id ? "true" : undefined}
                        onClick={() => { setFailure(null); setShown({ briefing: item, earlier: true }); }}
                        disabled={generating}
                        className={cn(
                          "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                          shown?.briefing.id === item.id
                            ? "border-navy-300 bg-secondary dark:border-navy-700"
                            : "border-border hover:bg-muted",
                        )}
                      >
                        <span className="block text-[12.5px] font-medium">{formatTime(item.generatedAt)}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {WINDOW_LABEL[item.window]} · {item.stats.updates} update{item.stats.updates === 1 ? "" : "s"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

function BriefingView({ briefing, base, fromHistory }: { briefing: Briefing; base: string; fromHistory: boolean }) {
  const { stats } = briefing;
  const range = `${formatTime(briefing.since)} – ${formatTime(briefing.until)}`;
  return (
    <article aria-label="Workspace briefing" className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            {briefing.source === "gemini" ? (
              <Badge tone="brand"><Sparkles aria-hidden="true" className="size-3" />Generated with Gemini</Badge>
            ) : briefing.source === "fallback" ? (
              <Badge tone="warn">Activity recap</Badge>
            ) : (
              <Badge tone="done">All caught up</Badge>
            )}
            <Badge>{WINDOW_LABEL[briefing.window]}</Badge>
            {fromHistory && <Badge>Earlier briefing</Badge>}
          </div>
          <CardTitle className="mt-1 text-[17px]">{headline(briefing)}</CardTitle>
          <CardDescription>
            {range}
            {briefing.window === "since_last" && briefing.firstBriefing && " · No earlier briefing in this browser, so this covers the last 24 hours."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Updates" value={stats.updates} />
            <Stat label="Tasks touched" value={stats.tasksTouched} />
            <Stat label="New comments" value={stats.comments} />
            <Stat label="Changes applied" value={stats.applied} />
          </dl>
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            {briefing.cutoffAdvanced
              ? `“Since last briefing” now starts from ${formatTime(briefing.until)}.`
              : briefing.source === "gemini"
                ? "This window did not reach back to your last briefing, so “Since last briefing” was left where it was."
                : "“Since last briefing” was not moved, so the next briefing covers this time again."}
          </p>
        </CardContent>
      </Card>

      {briefing.source === "fallback" && (
        <Notice title="The AI summary is unavailable right now">
          <p>{FALLBACK_COPY[briefing.fallbackReason ?? "model_failed"]} Below is a factual recap taken directly from the workspace records.</p>
        </Notice>
      )}

      {briefing.source === "empty" ? (
        <EmptyState icon={CircleCheck} title="Nothing changed in this window">
          No tasks, comments, reviews, or files changed {briefing.window === "last_hour" ? "in the last hour" : briefing.window === "last_24h" ? "in the last 24 hours" : "since your last briefing"}.
          {briefing.needsAttention.length > 0 ? " A few things are still waiting on someone, listed below." : ""}
        </EmptyState>
      ) : (
        <Section
          title="What changed"
          icon={ClipboardList}
          note={briefing.source === "gemini" ? "Summarized by Gemini from the records linked to each point." : "From workspace records."}
        >
          <ItemList items={briefing.changes} base={base} />
        </Section>
      )}

      <Section title="Needs attention" icon={GitCompare} note="Open questions and reviews, read from records.">
        {briefing.needsAttention.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No open questions or reviews are waiting.</p>
        ) : (
          <ul className="divide-y divide-border">
            {briefing.needsAttention.map((item, index) => (
              <li key={index} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2.5">
                  <Badge size="sm" tone={item.kind === "question" ? "warn" : "review"} className="mt-0.5 shrink-0">
                    {item.kind === "question" ? "Question" : "Review"}
                  </Badge>
                  <p className="min-w-0 text-[13px] leading-relaxed">{item.text}</p>
                </div>
                <Links links={item.links} base={base} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {briefing.nextSteps.length > 0 && (
        <Section title="Suggested next steps" icon={Lightbulb} note="Suggestions only. Nothing is done automatically.">
          <ol className="space-y-3">
            {briefing.nextSteps.map((item, index) => (
              <li key={index} className="flex gap-3">
                <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold text-secondary-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 space-y-2">
                  <p className="text-[13px] leading-relaxed">{item.text}</p>
                  <Links links={item.links} base={base} />
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {briefing.activity.length > 0 && (
        <details className="group rounded-xl border border-border bg-card shadow-xs [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-[13px] font-medium sm:px-6">
            <ListChecks aria-hidden="true" className="size-4 text-muted-foreground" />
            Activity details ({briefing.activity.length})
            <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">Every record this briefing is built on</span>
          </summary>
          <div className="border-t border-border p-4 sm:px-6">
            <ItemList items={briefing.activity} base={base} />
          </div>
        </details>
      )}
    </article>
  );
}

function Section({ title, icon: Icon, note, children }: { title: string; icon: typeof Sparkles; note: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3 sm:pb-3">
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <Icon aria-hidden="true" className="size-4 text-navy-600 dark:text-navy-300" />
          {title}
        </CardTitle>
        <CardDescription className="text-[11.5px]">{note}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ItemList({ items, base }: { items: BriefingItem[]; base: string }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((item, index) => (
        <li key={index} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed">{item.text}</p>
            {item.at && (
              <time dateTime={item.at} className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {formatTime(item.at)}
              </time>
            )}
          </div>
          <Links links={item.links} base={base} />
        </li>
      ))}
    </ul>
  );
}

function Links({ links, base }: { links: BriefingLink[]; base: string }) {
  if (links.length === 0) return null;
  return (
    <ul aria-label="Supporting records" className="flex flex-wrap gap-1.5">
      {links.map((link, index) => {
        const Icon = link.kind === "task" ? ClipboardList : link.kind === "review" ? GitCompare : FileText;
        const prefix = link.kind === "task" ? "Task" : link.kind === "review" ? "Review" : link.approved ? "File" : "Draft";
        return (
          <li key={index} className="min-w-0">
            <Link
              to={hrefFor(base, link)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-[11.5px] text-foreground/80 transition-colors hover:border-navy-300 hover:bg-secondary hover:text-foreground dark:hover:border-navy-700"
            >
              <Icon aria-hidden="true" className="size-3 shrink-0" />
              <span className="sr-only">{prefix}: </span>
              <span className={cn("truncate", link.kind === "file" && "font-mono")}>
                {link.label}
              </span>
              <ArrowRight aria-hidden="true" className="size-3 shrink-0 opacity-60" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
      <dt className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-[18px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** Routes come from typed IDs only; nothing in a briefing is used as a URL. */
export function hrefFor(base: string, link: BriefingLink): string {
  switch (link.kind) {
    case "task":
      return `${base}/tasks/${link.taskId}`;
    case "review":
      return `${base}/tasks/${link.taskId}?tab=Changes`;
    case "file":
      return link.approved || !link.taskId
        ? `${base}/files/view?path=${encodeURIComponent(link.path)}`
        : `${base}/tasks/${link.taskId}/drafts`;
  }
}

function headline(briefing: Briefing): string {
  const { stats } = briefing;
  if (briefing.source === "empty") return "You're all caught up";
  const updates = `${stats.updates} update${stats.updates === 1 ? "" : "s"}`;
  const tasks = stats.tasksTouched ? ` across ${stats.tasksTouched} task${stats.tasksTouched === 1 ? "" : "s"}` : "";
  const waiting = stats.openQuestions + stats.unresolvedReviews;
  return `${updates}${tasks}${waiting ? ` · ${waiting} waiting on someone` : ""}`;
}

function windowHint(window: BriefingWindow, cutoff: string | null, loading: boolean): string {
  if (window === "last_hour") return "Everything from the past 60 minutes.";
  if (window === "last_24h") return "Everything from the past day.";
  if (loading) return "Checking when you were last caught up…";
  return cutoff
    ? `Everything since your last briefing at ${formatTime(cutoff)}.`
    : "No earlier briefing in this browser yet, so this covers the last 24 hours.";
}

const FALLBACK_COPY: Record<NonNullable<Briefing["fallbackReason"]>, string> = {
  model_unavailable: "Gemini is not configured on this server.",
  model_failed: "Gemini did not respond in time or returned an error.",
  invalid_output: "Gemini's answer could not be matched to the workspace records, so it was not shown.",
};

function briefingError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "RATE_LIMITED":
        return "Briefings were requested too often. Wait a minute, then try again.";
      case "WORKSPACE_NOT_FOUND":
        return "This workspace could not be found. Check the contribution link.";
    }
  }
  return "We could not reach the server. Check your connection, then try again.";
}

function formatTime(value: string): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
