import { ApiError, eventKeys } from '@app/contracts';
import type { Appender } from '../events/service.js';
import { appendEvent } from '../events/service.js';

/** Caller holds the task row lock, or the workspace lock for workspace-wide changes. */
export async function assertTaskMutable(db: Appender, taskId: string): Promise<void> {
  const pending = await db.selectFrom('apply_operations as a').innerJoin('reviews as r', 'r.id', 'a.review_id')
    .select('a.id').where('r.task_id', '=', taskId).where('a.status', 'in', ['pending', 'ambiguous']).executeTakeFirst();
  if (pending) throw new ApiError('RUN_INTERRUPTED', 'Resolve the pending apply before changing this task.');
}

export async function assertWorkspaceMutable(db: Appender, workspaceId: string): Promise<void> {
  const pending = await db.selectFrom('apply_operations').select('id').where('workspace_id', '=', workspaceId)
    .where('status', 'in', ['pending', 'ambiguous']).executeTakeFirst();
  if (pending) throw new ApiError('RUN_INTERRUPTED', 'Resolve the pending apply before changing workspace guidance.');
}

/** Caller locks task before reviews; applied history is immutable. */
export async function invalidateTaskReviews(db: Appender, taskId: string, reason: string): Promise<void> {
  const changed = await db.updateTable('reviews').set({ status: 'stale', updated_at: new Date() })
    .where('task_id', '=', taskId).where('status', 'in', ['building', 'ready', 'conflict']).returningAll().execute();
  for (const review of changed) await appendEvent(db, {
    workspaceId: review.workspace_id, taskId, runId: review.run_id, type: 'review.stale',
    eventKey: eventKeys.reviewStale(review.id, reason), payload: { reviewId: review.id, reason },
  });
}
