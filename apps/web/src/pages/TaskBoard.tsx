import { Link } from "react-router-dom";
import { TASK_STATUSES, type TaskSummary } from "@app/contracts";
import { useState, type ReactNode } from "react";
import {
  HelpCircle,
  Eye,
  EyeOff,
  Paperclip,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { columnPresentation, groupTasks, statusPresentation } from "../board";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageHeading } from "../components/PageHeading";
import { Badge, Dot } from "../components/ui/badge";
import { Button, ButtonLink } from "../components/ui/button";
import { Input, Select } from "../components/ui/field";
import { Avatar } from "../components/ui/misc";

function TaskCard({ task, base, hidden, onToggleHidden }: { task: TaskSummary; base: string; hidden: boolean; onToggleHidden: () => void }) {
  const presentation = statusPresentation[task.status];
  return (
    <article className="group relative rounded-xl border border-border bg-card shadow-xs transition-all duration-150 hover:-translate-y-0.5 hover:border-navy-300 hover:shadow-md dark:hover:border-navy-600">
      <Link to={`${base}/tasks/${task.id}`} className="block p-3.5 pr-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Badge tone={presentation.tone} size="sm">
        <Dot
          tone={presentation.tone}
          live={task.status === "working" || task.status === "planning"}
        />
        {presentation.label}
      </Badge>

      <h4 className="mt-2.5 text-[13.5px] leading-snug font-semibold tracking-tight text-pretty transition-colors group-hover:text-navy-700 dark:group-hover:text-navy-200">
        {task.title}
      </h4>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
        {presentation.summary}
      </p>

      {task.openQuestionCount > 0 && (
        <span className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
          <HelpCircle className="size-3.5 shrink-0" aria-hidden="true" />
          {task.openQuestionCount === 1
            ? "1 question needs an answer"
            : `${task.openQuestionCount} questions need an answer`}
        </span>
      )}

      <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-border pt-2.5 text-[10.5px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={task.creatorGuestLabel} size="sm" />
          <span className="truncate">{task.creatorGuestLabel}</span>
        </span>
        {task.materialCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            <Paperclip className="size-3" aria-hidden="true" />
            {task.materialCount}
          </span>
        )}
      </div>
      </Link>
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute top-2.5 right-2.5"
        aria-label={hidden ? `Show ${task.title}` : `Hide ${task.title}`}
        title={hidden ? "Show on board" : "Hide from board"}
        onClick={onToggleHidden}
      >
        {hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
      </Button>
    </article>
  );
}

export function TaskBoard({
  tasks,
  base,
  heading,
  hiddenIds = [],
  showHidden = false,
  onToggleHidden,
  onToggleShowHidden,
}: {
  tasks: TaskSummary[];
  base: string;
  /** Replaces the default header, so a live workspace can show its own name. */
  heading?: ReactNode;
  hiddenIds?: string[];
  showHidden?: boolean;
  onToggleHidden?: (taskId: string) => void;
  onToggleShowHidden?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const visibleTasks = showHidden ? tasks : tasks.filter((task) => !hiddenIds.includes(task.id));
  const filtered = visibleTasks.filter(
    (task) =>
      task.title.toLowerCase().includes(query.toLowerCase()) &&
      (status === "all" || task.status === status || (status === "ready_for_review" && task.status === "awaiting_confirmation")),
  );
  const filtering = query !== "" || status !== "all";

  return (
    <>
      {heading ?? (
        <PageHeading
          eyebrow="Your shared workspace"
          title="Good work starts here."
          description="Bring an idea. Shape it together. Ship something useful."
          actions={
            <ButtonLink variant="primary" to={`${base}/tasks/new`}>
              <Plus aria-hidden="true" />
              Post a task
            </ButtonLink>
          }
        />
      )}

      <div className="mb-5 flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight">
            Task board
          </h2>
          <Badge size="sm" className="tabular-nums">
            {filtered.length}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hiddenIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={onToggleShowHidden}>
              {showHidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              {showHidden ? "Hide hidden tasks" : `Show hidden (${hiddenIds.length})`}
            </Button>
          )}
          <label className="sr-only" htmlFor="search">
            Search tasks
          </label>
          <div className="relative w-full sm:w-56">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="search"
              type="search"
              placeholder="Search tasks…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 pl-8.5 text-[12.5px]"
            />
          </div>
          <label className="sr-only" htmlFor="status">
            Filter by status
          </label>
          <div className="relative w-full sm:w-44">
            <Select
              id="status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-9 pl-8.5 text-[12.5px]"
            >
              <option value="all">All statuses</option>
              {TASK_STATUSES.filter((value) => value !== "awaiting_confirmation").map((value) => (
                <option value={value} key={value}>
                  {statusPresentation[value].label}
                </option>
              ))}
            </Select>
            <SlidersHorizontal
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState
          title="Make room for your first idea."
          action={
            <ButtonLink variant="primary" to={`${base}/tasks/new`}>
              <Plus aria-hidden="true" />
              Post a task
            </ButtonLink>
          }
        >
          Describe a small piece of work to begin. You can discuss the details
          before starting.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={visibleTasks.length === 0 ? "All tasks are hidden" : "No matching tasks"}
          icon={Search}
          action={
            <Button
              onClick={() => {
                if (visibleTasks.length === 0) onToggleShowHidden?.();
                else { setQuery(""); setStatus("all"); }
              }}
            >
              {visibleTasks.length === 0 ? "Show hidden tasks" : "Clear filters"}
            </Button>
          }
        >
          {visibleTasks.length === 0 ? "Hidden tasks stay available in this browser." : "Try a different title or status."}
        </EmptyState>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
          <div className={cn("grid gap-4", status !== "all" && "max-w-sm")} style={{ gridTemplateColumns: `repeat(${status === "all" ? 5 : 1}, minmax(210px, 1fr))` }}>
            {groupTasks(filtered).filter((column) => status === "all" || column.tasks.length > 0).map((column) => {
              const meta = columnPresentation[column.name];
              return (
                <section
                  key={column.name}
                  aria-label={column.name}
                  className="flex min-w-0 flex-col"
                >
                  <h3
                    className="mb-3 flex items-center gap-2 text-[11.5px] font-semibold tracking-tight"
                    title={meta.hint}
                  >
                    <Dot tone={meta.tone} />
                    <span>{column.name}</span>
                    <Badge
                      size="sm"
                      className="ml-auto shrink-0 tabular-nums"
                      tone={column.tasks.length > 0 ? meta.tone : "neutral"}
                    >
                      {column.tasks.length}
                    </Badge>
                  </h3>
                  <div className="grid content-start gap-2.5">
                    {column.tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        base={base}
                        hidden={hiddenIds.includes(task.id)}
                        onToggleHidden={() => onToggleHidden?.(task.id)}
                      />
                    ))}
                    {column.tasks.length === 0 && (
                      <p
                        className={cn(
                          "rounded-xl border border-dashed border-border px-3 py-7 text-center text-[11.5px] text-muted-foreground",
                          filtering && "opacity-60",
                        )}
                      >
                        No tasks here yet
                      </p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-6 text-[11.5px] text-muted-foreground">
        Open a task to mark it complete or unmark it. Anyone in the workspace can
        update completion, and you can run tasks again whenever you need to.
      </p>
    </>
  );
}
