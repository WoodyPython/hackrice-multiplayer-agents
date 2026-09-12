import { TASK_STATUSES, type TaskStatus, type TaskSummary } from '@app/contracts';

export const BOARD_COLUMNS = [
  { id: 'posted', label: 'Posted', description: 'Ready to shape' },
  { id: 'working', label: 'Working', description: 'In progress' },
  { id: 'attention', label: 'Needs attention', description: 'Waiting on people' },
  { id: 'review', label: 'Review', description: 'Ready to inspect' },
  { id: 'completed', label: 'Completed', description: 'Applied or closed' },
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]['id'];

const STATUS_TO_COLUMN: Record<TaskStatus, BoardColumnId> = {
  posted: 'posted',
  planning: 'working',
  working: 'working',
  needs_input: 'attention',
  ready_for_review: 'review',
  conflict: 'attention',
  incomplete: 'attention',
  interrupted: 'attention',
  canceled: 'completed',
  completed: 'completed',
};

// Makes newly-added contract statuses a compile-time failure until the board handles them.
void (TASK_STATUSES satisfies readonly (keyof typeof STATUS_TO_COLUMN)[]);

export function columnForStatus(status: TaskStatus): BoardColumnId {
  return STATUS_TO_COLUMN[status];
}

export function groupTasksByColumn(tasks: readonly TaskSummary[]) {
  const grouped: Record<BoardColumnId, TaskSummary[]> = {
    posted: [],
    working: [],
    attention: [],
    review: [],
    completed: [],
  };

  for (const task of tasks) {
    grouped[columnForStatus(task.status)].push(task);
  }

  return grouped;
}
