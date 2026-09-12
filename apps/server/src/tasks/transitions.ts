import { ApiError, type TaskStatus } from '@app/contracts';

/**
 * Task state machine (design section 2.4).
 *
 * Section 2.4 names the states and the principal actions available in each, but
 * does not enumerate legal transitions. These are derived from it and are the
 * single place that derivation lives, so routes and services cannot disagree.
 *
 * Enforced in the service layer under a row lock rather than by a database
 * trigger. Section 11.2 mandates database-level transition checks for AGENT
 * instances specifically, because a late write from an expired agent is a
 * correctness problem; a task transition is only ever driven by an API call
 * that already holds the row.
 */

/** Where a task may go next, by current status. */
const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  // Available for discussion; Start is the only forward move.
  posted: ['planning', 'canceled'],

  // Orchestrator is producing assignments.
  planning: ['working', 'needs_input', 'incomplete', 'interrupted', 'canceled', 'conflict'],

  // Workers executing.
  working: [
    'needs_input',
    'ready_for_review',
    'conflict',
    'incomplete',
    'interrupted',
    'canceled',
    'completed',
  ],

  // An agent is waiting on a human answer.
  needs_input: [
    'working',
    'ready_for_review',
    'incomplete',
    'interrupted',
    'canceled',
    'conflict',
  ],

  // Result available for the owner.
  ready_for_review: ['conflict', 'completed', 'planning', 'canceled', 'incomplete'],

  // Needs explicit resolution; a revision is a new attempt.
  conflict: ['ready_for_review', 'planning', 'completed', 'canceled'],

  // Retryable failure states (section 2.4: "manual retry").
  incomplete: ['planning', 'canceled', 'completed'],
  interrupted: ['planning', 'canceled', 'completed'],
  canceled: ['planning'],

  // Section 2.4: "Read result/history, create another task." Read-only.
  completed: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

export function assertTransition(
  from: TaskStatus,
  to: TaskStatus,
  context: string,
): void {
  if (canTransition(from, to)) return;
  throw new ApiError(
    'INVALID_STATE',
    `Cannot ${context}: a task in "${from}" cannot become "${to}".`,
    { currentStatus: from, attemptedStatus: to },
  );
}

/**
 * Revising requirements.
 *
 * Section 2.3 explicitly permits this during execution: "Existing execution may
 * finish, but its result is labeled against the older version and cannot be
 * applied without review against the updated requirements." So the only bar is
 * `completed`, which section 2.4 defines as read-only.
 */
export function assertRevisable(status: TaskStatus): void {
  if (status !== 'completed') return;
  throw new ApiError(
    'INVALID_STATE',
    'This task was applied and is read-only. Create another task instead.',
    { currentStatus: status },
  );
}

/**
 * Cancelling.
 *
 * Only meaningful while an attempt is live. Section 2.4 gives cancel as a
 * principal action in planning, working, and needs_input, and nowhere else.
 */
export function assertCancelable(status: TaskStatus): void {
  if (status === 'planning' || status === 'working' || status === 'needs_input') return;
  throw new ApiError(
    'INVALID_STATE',
    `Nothing to cancel: this task is "${status}", not running.`,
    { currentStatus: status },
  );
}
