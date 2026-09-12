import type { TaskEventType } from '@app/contracts';
import type { Db } from '../db/client.js';
import type { Transaction } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * Durable task events (design section 11.5).
 *
 * B03 needs to append events before B06 exists, so this is the append half
 * only. B06 adds the Supabase Broadcast hint and the read API on top.
 *
 * "Persist task events before broadcasting their IDs" — that ordering is why
 * append is separable at all, and why a missing broadcaster is not a
 * correctness problem: the event is already durable, and a browser that
 * refetches sees the same state a broadcast would have prompted it to fetch.
 */

export type Appender = Db | Transaction<Database>;

export interface AppendEventInput {
  workspaceId: string;
  taskId: string;
  runId?: string | null;
  /** Deterministic where the operation may repeat (section 11.5). */
  eventKey: string;
  type: TaskEventType;
  payload?: Record<string, unknown>;
}

export interface AppendedEvent {
  eventId: string;
  /** False when this key was already present, i.e. the append was a no-op. */
  created: boolean;
}

/**
 * Appends one event, idempotently on (task_id, event_key).
 *
 * Takes a transaction so an event and the state change it describes commit
 * together. An event announcing a run that failed to be created would be worse
 * than no event at all, since section 11.5 makes events the durable progress
 * record a reconnecting browser reads.
 */
export async function appendEvent(
  db: Appender,
  input: AppendEventInput,
): Promise<AppendedEvent> {
  const inserted = await db
    .insertInto('task_events')
    .values({
      workspace_id: input.workspaceId,
      task_id: input.taskId,
      run_id: input.runId ?? null,
      event_key: input.eventKey,
      type: input.type,
      payload: input.payload ?? {},
    })
    .onConflict((oc) => oc.columns(['task_id', 'event_key']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (inserted) return { eventId: String(inserted.id), created: true };

  // Lost the race, or a genuine replay. Either way the event exists; return the
  // existing id so callers see a stable value.
  const existing = await db
    .selectFrom('task_events')
    .select('id')
    .where('task_id', '=', input.taskId)
    .where('event_key', '=', input.eventKey)
    .executeTakeFirstOrThrow();

  return { eventId: String(existing.id), created: false };
}
