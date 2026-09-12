import { type TaskStatus, type TaskSummary } from "@app/contracts";

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
  posted: { column: "Posted", label: "Posted", summary: "Ready to start when you are" },
  planning: {
    column: "Working",
    label: "Planning",
    summary: "Planning assignments",
  },
  working: {
    column: "Working",
    label: "Working",
    summary: "Agents are working",
  },
  needs_input: {
    column: "Needs attention",
    label: "Needs input",
    summary: "Waiting for your answer",
  },
  ready_for_review: {
    column: "Review",
    label: "Ready for review",
    summary: "Owner review needed",
  },
  conflict: {
    column: "Needs attention",
    label: "Conflict",
    summary: "Overlapping edits need resolution",
  },
  incomplete: {
    column: "Needs attention",
    label: "Incomplete",
    summary: "Saved work is available to inspect",
  },
  interrupted: {
    column: "Needs attention",
    label: "Interrupted",
    summary: "Checkpoint preserved for retry",
  },
  canceled: {
    column: "Needs attention",
    label: "Canceled",
    summary: "Stopped — saved work remains available",
  },
  completed: {
    column: "Completed",
    label: "Completed",
    summary: "Reviewed and complete",
  },
} satisfies Record<
  TaskStatus,
  { column: (typeof columns)[number]; label: string; summary: string }
>;

export function groupTasks(tasks: TaskSummary[]) {
  return columns.map((name) => ({
    name,
    tasks: tasks.filter(
      (task) => statusPresentation[task.status].column === name,
    ),
  }));
}
