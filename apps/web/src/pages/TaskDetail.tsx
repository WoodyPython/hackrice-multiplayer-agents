import { useEffect, useState, type ReactNode } from "react";
// `Square` went with the acceptance-criteria list; `useEffect` drives the tab sync.
import { FileText, PencilLine } from "lucide-react";
import { type TaskDetail as Task } from "@app/contracts";
import { statusPresentation } from "../board";
import { inputLabel, type TaskInputOption } from "../task-inputs";
import { cn } from "../lib/utils";
import { BackLink, PageHeading } from "../components/PageHeading";
import { Badge, Dot } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Eyebrow, Path } from "../components/ui/misc";

export const tabs = ["Discussion", "Drafts", "Agents", "Changes"] as const;
export type TaskTab = (typeof tabs)[number];

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-6 mb-2 text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase first:mt-0">
      {children}
    </h3>
  );
}

/**
 * Task detail layout (design §4.2).
 *
 * Presentational on purpose: it owns the header, the requirements panel, and
 * the tab strip, and the caller supplies both the primary action and each tab's
 * body. That is what lets the live page and the fixture demo render the same
 * screen without the demo's shapes leaking into the live one — the previous
 * version imported `inputOptions` from `fixtures.ts`, so the live task detail
 * would have labelled real inputs against three invented IDs.
 *
 * Discussion is the default tab, per §4.2: "Before start, Discussion is the
 * default tab."
 */
export function TaskDetail({
  task,
  base,
  options,
  action,
  banner,
  taskFiles,
  renderTab,
  onEditRequirements,
  initialTab,
  attention,
  backTo,
}: {
  task: Task;
  base: string;
  backTo?: string;
  options: TaskInputOption[];
  action?: ReactNode;
  /** Run-level explanation (§4.7), shown above the panels rather than in a tab. */
  banner?: ReactNode;
  /** Direct task attachments and the upload affordance. */
  taskFiles?: ReactNode;
  renderTab: (tab: TaskTab) => ReactNode;
  onEditRequirements?: () => void;
  /**
   * Tabs with something waiting on the reader, marked with a dot.
   *
   * The dot is accompanied by off-screen text, because a coloured dot alone
   * conveys nothing to a screen reader and nothing to anyone who cannot
   * distinguish it from the tab label's own colour.
   */
  attention?: readonly TaskTab[];
  /**
   * Opens on a specific tab. §4.2 makes Discussion the default; this exists so
   * an action that says it will show you the review actually does, rather than
   * landing on the task and leaving the reader to find it.
   */
  initialTab?: TaskTab;
}) {
  const [tab, setTab] = useState<TaskTab>(initialTab ?? "Discussion");
  // `initialTab` is the `?tab=` query parameter. Following it after mount is
  // what lets an action elsewhere on the page say "read the changes" and
  // actually land there, and it keeps the opened tab in the URL so the view is
  // linkable. A user's own click still wins until the parameter changes again.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const presentation = statusPresentation[task.status];

  return (
    <>
      <BackLink to={backTo ?? base}>{backTo ? "Back to history" : "All tasks"}</BackLink>

      <PageHeading
        badge={
          <Badge tone={presentation.tone}>
            <Dot
              tone={presentation.tone}
              live={task.status === "working" || task.status === "planning"}
            />
            {presentation.label}
          </Badge>
        }
        title={task.title}
        description={
          <>
            Posted by {task.creatorGuestLabel}
            {task.kind === "manual_edit" && " · Manual edit"}
          </>
        }
        actions={action}
      />

      {banner && <div className="mb-6 space-y-4">{banner}</div>}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] xl:gap-6">
        <section className="rounded-xl border border-border bg-card p-5 shadow-xs lg:sticky lg:top-20">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Eyebrow>The brief</Eyebrow>
              <h2 className="mt-1.5 text-base font-semibold tracking-tight">
                Requirements
              </h2>
            </div>
            {onEditRequirements && (
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                onClick={onEditRequirements}
              >
                <PencilLine aria-hidden="true" />
                Edit requirements
              </Button>
            )}
          </div>

          <SectionLabel>Desired outcome</SectionLabel>
          <p className="text-[13px] leading-relaxed text-muted-foreground text-pretty">
            {task.outcome || "No outcome added yet."}
          </p>

          <SectionLabel>Selected inputs</SectionLabel>
          {task.inputs.length ? (
            <ul className="space-y-1.5">
              {task.inputs.map((input) => (
                <li
                  key={input.id}
                  className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5"
                >
                  <FileText
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate text-[12.5px]">
                    {inputLabel(input, options)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              No inputs selected.
            </p>
          )}

          {taskFiles}

          <SectionLabel>Intended output paths</SectionLabel>
          {task.outputPaths.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {task.outputPaths.map((path) => (
                <li key={path}>
                  <Path>{path}</Path>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              No output paths specified.
            </p>
          )}
        </section>

        <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          <div
            className="flex gap-1 overflow-x-auto border-b border-border px-2 cf-scrollbar-none"
            role="tablist"
            aria-label="Task activity"
          >
            {tabs.map((name, index) => (
              <button
                key={name}
                type="button"
                id={`tab-${name}`}
                role="tab"
                aria-selected={tab === name}
                aria-controls="activity-panel"
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + tabs.length - 1) % tabs.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? tabs.length - 1
                            : null;
                  if (next !== null) {
                    event.preventDefault();
                    setTab(tabs[next]!);
                    document.getElementById(`tab-${tabs[next]}`)?.focus();
                  }
                }}
                className={cn(
                  "-mb-px shrink-0 border-b-2 px-3 py-3.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                  tab === name
                    ? "border-navy-700 text-navy-800 dark:border-navy-300 dark:text-navy-200"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {name}
                {attention?.includes(name) && (
                  <>
                    <span
                      aria-hidden="true"
                      className="ml-1.5 inline-block size-1.5 rounded-full bg-status-review align-middle"
                    />
                    <span className="sr-only"> (needs attention)</span>
                  </>
                )}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="activity-panel"
            aria-labelledby={`tab-${tab}`}
            tabIndex={0}
            className="p-5 outline-none sm:p-6"
          >
            {renderTab(tab)}
          </div>
        </section>
      </div>
    </>
  );
}
