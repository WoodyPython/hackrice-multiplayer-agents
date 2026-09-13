import { type TaskStatus, type TaskSummary } from "@app/contracts";

/**
 * The visual register a state is shown in. Screens ask for a tone rather than
 * building a class name out of a status string, so a status the API adds later
 * renders as neutral instead of unstyled.
 */
export type Tone = "neutral" | "info" | "warn" | "review" | "done" | "danger";

/**
 * Board placement and per-status copy (design §4.3).
 *
 * Every `summary` below describes the TASK STATE and nothing else. An earlier
 * version named agents and steps here — `working` read "Writer · preparing a
 * first draft" — which the card rendered for every working task regardless of
 * what was actually running, or whether anything was. §4.7 rules that out:
 * "avoid fake progress". The API carries no assignment summary on
 * `TaskSummary`, so the honest board says what state the task is in and leaves
 * the assignment detail to the Agents tab, which reads real records.
 */

export const columns = [
  "Posted",
  "Working",
  "Needs attention",
  "Review",
  "Completed",
] as const;
export const statusPresentation = {
  posted: {
    column: "Posted",
    label: "Posted",
    summary: "Ready to start when you are",
    tone: "neutral",
  },
  planning: {
    column: "Working",
    label: "Planning",
    summary: "Planning assignments",
    tone: "info",
  },
  working: {
    column: "Working",
    label: "Working",
    summary: "Agents are working",
    tone: "info",
  },
  needs_input: {
    column: "Needs attention",
    label: "Needs input",
    summary: "Waiting for your answer",
    tone: "warn",
  },
  ready_for_review: {
    column: "Review",
    label: "Ready for review",
    summary: "Waiting for someone to review",
    tone: "review",
  },
  conflict: {
    column: "Needs attention",
    label: "Conflict",
    summary: "Overlapping edits need resolution",
    tone: "warn",
  },
  incomplete: {
    column: "Needs attention",
    label: "Incomplete",
    summary: "Saved work is available to inspect",
    tone: "warn",
  },
  interrupted: {
    column: "Needs attention",
    label: "Interrupted",
    summary: "Checkpoint preserved for retry",
    tone: "warn",
  },
  canceled: {
    column: "Needs attention",
    label: "Canceled",
    summary: "Stopped — saved work remains available",
    tone: "warn",
  },
  completed: {
    column: "Completed",
    label: "Completed",
    summary: "Reviewed and complete",
    tone: "done",
  },
} satisfies Record<
  TaskStatus,
  {
    column: (typeof columns)[number];
    label: string;
    summary: string;
    tone: Tone;
  }
>;

export function groupTasks(tasks: TaskSummary[]) {
  return columns.map((name) => ({
    name,
    tasks: tasks.filter(
      (task) => statusPresentation[task.status].column === name,
    ),
  }));
}

/** Column heading treatment, so the board is not re-deriving it from the label. */
export const columnPresentation = {
  Posted: { tone: "neutral", hint: "Waiting to be started" },
  Working: { tone: "info", hint: "Agents are running" },
  "Needs attention": { tone: "warn", hint: "Blocked on a person" },
  Review: { tone: "review", hint: "Ready to be read" },
  Completed: { tone: "done", hint: "Applied to the approved files" },
} satisfies Record<(typeof columns)[number], { tone: Tone; hint: string }>;

/**
 * Tone for the states that are not task statuses — attempts, assignments,
 * reviews, apply operations and questions all carry their own vocabularies.
 *
 * Deliberately total: an unrecognised state is neutral rather than unstyled,
 * because none of these sets is closed and a new code must not render as
 * invisible text.
 */
const TONES: Record<string, Tone> = {
  // In flight.
  planning: "info",
  working: "info",
  running: "info",
  building: "info",
  dispatched: "info",
  pending: "info",
  queued: "info",
  // Blocked on a person.
  needs_input: "warn",
  conflict: "warn",
  incomplete: "warn",
  interrupted: "warn",
  canceled: "warn",
  cancelled: "warn",
  stale: "warn",
  ambiguous: "warn",
  timed_out: "warn",
  // Awaiting a read.
  ready: "review",
  ready_for_review: "review",
  open: "review",
  // Settled well.
  completed: "done",
  succeeded: "done",
  applied: "done",
  answered: "done",
  // Settled badly.
  failed: "danger",
  error: "danger",
};

export function toneFor(status: string): Tone {
  return TONES[status] ?? "neutral";
}

/** `needs_input` → `needs input`, for states with no curated label. */
export function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ");
}
