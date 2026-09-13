import { Bot, Timer, Workflow } from "lucide-react";
import type { AssignmentProgress, TaskAttempt } from "@app/contracts";
import { humanizeStatus, toneFor } from "../board";
import { cn } from "../lib/utils";
import { EmptyState } from "./EmptyState";
import { Badge, Dot } from "./ui/badge";
import { Path } from "./ui/misc";

/**
 * Agent progress (design §4.5).
 *
 * Three rules from that section shape this, and all three are about restraint:
 *
 * **Parallel workers are visibly distinct.** Assignments form a DAG, not a
 * list, so they are laid out in dependency layers: everything with no unmet
 * prerequisite sits in the first wave, everything depending only on that in the
 * second, and so on. Two assignments in the same wave genuinely can run at the
 * same time, which is the fact §4.5 asks to be made visible. A flat list would
 * render the same data and show none of it.
 *
 * **No model selection, provider settings, budget settings, or timeout
 * controls.** Nothing here is an input. The server does not send those fields
 * at all, which is the real guarantee; this component simply has nothing to
 * render them from.
 *
 * **Time left is display, never authority.** The deadline is fixed by the
 * backend and is not extended by waiting, retrying, or replanning. What is
 * shown is the remaining wall clock against `deadlineAt`, and when it passes,
 * the honest statement is that the deadline has passed — not that the agent has
 * stopped, which only its status can say.
 */
export function Assignments({ attempts }: { attempts: TaskAttempt[] }) {
  if (attempts.length === 0)
    return (
      <EmptyState title="No attempt has run yet" icon={Bot}>
        Starting this task plans the work and dispatches agents. Nothing runs
        until someone starts it.
      </EmptyState>
    );

  return (
    <div className="space-y-6">
      {attempts.map((attempt, index) => (
        <section
          key={attempt.runId}
          aria-label={`Attempt ${attempt.attempt}`}
          className="overflow-hidden rounded-xl border border-border"
        >
          <header className="flex flex-wrap items-center gap-2.5 border-b border-border bg-muted/40 px-4 py-3">
            <h3 className="text-[13px] font-semibold tracking-tight">
              Attempt {attempt.attempt}
              {index === 0 && attempts.length > 1 && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  · latest
                </span>
              )}
            </h3>
            <Badge tone={toneFor(attempt.status)} size="sm">
              <Dot
                tone={toneFor(attempt.status)}
                live={
                  attempt.status === "working" || attempt.status === "planning"
                }
              />
              {humanizeStatus(attempt.status)}
            </Badge>
          </header>

          <div className="p-4">
            {attempt.assignments.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                This attempt ended before any assignment was created.
              </p>
            ) : (
              <div className="space-y-4">
                {layer(attempt.assignments).map((wave, depth) => (
                  <div key={depth} className="relative">
                    <div className="mb-2 flex items-center gap-2">
                      <Workflow
                        aria-hidden="true"
                        className="size-3.5 text-muted-foreground"
                      />
                      <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                        {wave.length > 1
                          ? `${wave.length} in parallel`
                          : depth === 0
                            ? "First"
                            : "Then"}
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-px flex-1 bg-border"
                      />
                    </div>
                    <ul
                      className={cn(
                        "grid gap-2.5",
                        wave.length > 1 && "sm:grid-cols-2",
                      )}
                    >
                      {wave.map((assignment) => (
                        <Assignment
                          key={assignment.id}
                          assignment={assignment}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function Assignment({ assignment }: { assignment: AssignmentProgress }) {
  const left = remaining(assignment);
  const tone = toneFor(assignment.status);
  return (
    <li className="min-w-0 rounded-lg border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-secondary px-2 py-0.5 font-mono text-[11px] font-medium text-secondary-foreground">
          {assignment.preset}
        </span>
        <Badge tone={tone} size="sm">
          <Dot tone={tone} live={assignment.status === "running"} />
          {humanizeStatus(assignment.status)}
        </Badge>
        {left && (
          <small className="ml-auto flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
            <Timer aria-hidden="true" className="size-3" />
            {left}
          </small>
        )}
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground text-pretty">
        {assignment.instructionSummary}
      </p>

      {assignment.writePaths.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {assignment.writePaths.map((path) => (
            <li key={path}>
              <Path>{path}</Path>
            </li>
          ))}
        </ul>
      ) : (
        <small className="mt-2.5 block text-[11.5px] text-muted-foreground">
          Writes nothing; reads and reports.
        </small>
      )}
    </li>
  );
}

/**
 * Remaining time against the backend's fixed deadline.
 *
 * Only for an agent that is actually running: a pending agent has no deadline
 * yet (`deadlineAt` is null until it starts), and a settled one's deadline is
 * no longer meaningful. Past zero this says the deadline passed rather than
 * that the agent stopped — the two are different, and only `status` knows the
 * second.
 */
function remaining(assignment: AssignmentProgress): string | null {
  if (assignment.deadlineAt === null) return null;
  if (assignment.status !== "running" && assignment.status !== "needs_input")
    return null;
  const ms = new Date(assignment.deadlineAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "deadline passed";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")} left`;
}

/**
 * Group assignments into dependency waves.
 *
 * A node belongs to the first wave in which every prerequisite it names has
 * already been placed. Dependencies that point outside this set — which should
 * not happen, but a plan is model output that was validated elsewhere — are
 * ignored rather than treated as unsatisfiable, so a malformed graph degrades
 * to a flatter layout instead of rendering nothing.
 *
 * The loop is bounded by the number of assignments: if a pass places nothing,
 * the remainder is emitted as one final wave. That is the cycle case, and a
 * screen that silently drops assignments would be worse than one that shows
 * them in the wrong order.
 */
export function layer(
  assignments: AssignmentProgress[],
): AssignmentProgress[][] {
  const known = new Set(assignments.map((a) => a.id));
  const placed = new Set<string>();
  const waves: AssignmentProgress[][] = [];
  let rest = [...assignments];

  while (rest.length > 0) {
    const wave = rest.filter((a) =>
      a.dependsOn.every((id) => !known.has(id) || placed.has(id)),
    );
    if (wave.length === 0) {
      waves.push(rest);
      break;
    }
    waves.push(wave);
    for (const a of wave) placed.add(a.id);
    rest = rest.filter((a) => !placed.has(a.id));
  }
  return waves;
}
