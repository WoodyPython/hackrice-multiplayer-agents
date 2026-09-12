import type { AssignmentProgress, TaskAttempt } from "@app/contracts";
import { EmptyState } from "./EmptyState";

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
      <EmptyState title="No attempt has run yet">
        Starting this task plans the work and dispatches agents. Nothing runs
        until someone starts it.
      </EmptyState>
    );

  return (
    <div className="attempts">
      {attempts.map((attempt, index) => (
        <section
          className="attempt"
          key={attempt.runId}
          aria-label={`Attempt ${attempt.attempt}`}
        >
          <header className="attempt-head">
            <h3>
              Attempt {attempt.attempt}
              {index === 0 && attempts.length > 1 && (
                <span className="latest-tag"> · latest</span>
              )}
            </h3>
            <span className={`status status-${attempt.status}`}>
              {attempt.status.replace(/_/g, " ")}
            </span>
            <small className="muted">
              Against task version {attempt.taskVersion}
            </small>
          </header>
          {attempt.assignments.length === 0 ? (
            <p className="muted">
              This attempt ended before any assignment was created.
            </p>
          ) : (
            layer(attempt.assignments).map((wave, depth) => (
              <div className="wave" key={depth}>
                <span className="wave-label">
                  {wave.length > 1
                    ? `${wave.length} in parallel`
                    : depth === 0
                      ? "First"
                      : "Then"}
                </span>
                <ul className="assignment-list">
                  {wave.map((assignment) => (
                    <Assignment key={assignment.id} assignment={assignment} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      ))}
    </div>
  );
}

function Assignment({ assignment }: { assignment: AssignmentProgress }) {
  const left = remaining(assignment);
  return (
    <li className={`assignment agent-${assignment.status}`}>
      <div className="assignment-head">
        <span className="preset">{assignment.preset}</span>
        <span className={`status status-${assignment.status}`}>
          {assignment.status.replace(/_/g, " ")}
        </span>
        {left && <small className="deadline">{left}</small>}
      </div>
      <p className="instruction">{assignment.instructionSummary}</p>
      {assignment.writePaths.length > 0 && (
        <ul className="file-list">
          {assignment.writePaths.map((path) => (
            <li key={path}>
              <code className="path">{path}</code>
            </li>
          ))}
        </ul>
      )}
      {assignment.writePaths.length === 0 && (
        <small className="muted">Writes nothing; reads and reports.</small>
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
export function layer(assignments: AssignmentProgress[]): AssignmentProgress[][] {
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
