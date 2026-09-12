import { type TaskStatus, type TaskSummary } from "@app/contracts";

export const columns = [
  "Posted",
  "Working",
  "Needs attention",
  "Review",
  "Completed",
] as const;
export const statusPresentation = {
  posted: { column: "Posted", label: "Posted", summary: "Ready when you are" },
  planning: {
    column: "Working",
    label: "Planning",
    summary: "Orchestrator · planning assignments",
  },
  working: {
    column: "Working",
    label: "Working",
    summary: "Writer · preparing a first draft",
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
    summary: "Stopped · saved work remains available",
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
