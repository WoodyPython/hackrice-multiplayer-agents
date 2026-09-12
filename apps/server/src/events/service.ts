import type { Transaction } from 'kysely';
import {
  ApiError,
  type RefreshHint,
  type TaskEvent,
  type TaskEventType,
  taskEventTypeSchema,
  workspaceChannel,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { Database } from '../db/types.js';
import { toIso } from '../http/serialize.js';
import type { Broadcaster } from './broadcaster.js';

/**
 * B06: durable task events and refresh hints (design section 11.5).
 *
 * "Persist task events before broadcasting their IDs."
 *
 * That ordering is the whole design of this module. `append` runs inside the
 * caller's transaction, so an event and the state change it describes commit
 * together; `broadcastHint` runs after that transaction resolves. The two are
 * deliberately separate calls rather than one convenience method, because a
 * single method could only broadcast from inside the transaction, and then a
 * rollback would leave clients refetching a state change that never happened.
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
  if (!db.isTransaction) return db.transaction().execute((trx) => appendEvent(trx, input));
  // Allocate the identity only after serializing this task's writers. Sequence
  // allocation alone does not imply commit order, which cursor readers need.
  const task = await db.selectFrom('tasks').select('id').where('id', '=', input.taskId)
    .where('workspace_id', '=', input.workspaceId).forUpdate().executeTakeFirst();
  if (!task) throw new ApiError('TASK_NOT_FOUND');
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

// ---------------------------------------------------------------------------

export interface TaskEventServiceDeps {
  db: Db;
  broadcaster: Broadcaster;
}

export class TaskEventService {
  constructor(private readonly deps: TaskEventServiceDeps) {}

  /** Design section 12.4, EventService.append. */
  async append(input: AppendEventInput): Promise<AppendedEvent> {
    return appendEvent(this.deps.db, input);
  }

  /**
   * Design section 12.4, EventService.broadcastHint.
   *
   * Call this AFTER the transaction that appended the event has committed.
   * Fire-and-forget by contract: a hint is a latency optimisation over the
   * polling section 5 already specifies, so a transport failure must not fail
   * the operation that produced the event.
   */
  broadcastHint(input: {
    workspaceId: string;
    taskId: string | null;
    type: TaskEventType;
    eventId: string;
  }): void {
    const hint: RefreshHint = {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      eventType: input.type,
      eventId: input.eventId,
    };
    void this.deps.broadcaster.hint(hint).catch(() => undefined);
  }

  /**
   * Appends inside a transaction and returns a function to broadcast after it.
   *
   * The shape exists to make the ordering hard to get wrong: the caller cannot
   * broadcast without first having appended, and the returned closure is only
   * useful once the surrounding transaction has resolved.
   */
  async appendIn(
    trx: Appender,
    input: AppendEventInput,
  ): Promise<{ event: AppendedEvent; broadcast: () => void }> {
    const event = await appendEvent(trx, input);
    return {
      event,
      broadcast: () =>
        this.broadcastHint({
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          type: input.type,
          eventId: event.eventId,
        }),
    };
  }

  /**
   * The durable progress record for a task (section 11.5).
   *
   * "A browser reconnect fetches current task state and recent discussion."
   * Cursor-paginated by id, so a client that missed hints while disconnected
   * reads forward from where it stopped rather than re-reading everything.
   */
  async listForTask(
    workspaceId: string,
    taskId: string,
    options: { afterId?: number; limit: number },
  ): Promise<{ events: TaskEvent[]; latestId: string | null }> {
    let query = this.deps.db
      .selectFrom('task_events')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('task_id', '=', taskId)
      .orderBy('id')
      .limit(options.limit);

    if (options.afterId !== undefined) {
      query = query.where('id', '>', options.afterId);
    }

    const rows = await query.execute();

    const newest = await this.deps.db
      .selectFrom('task_events')
      .select((eb) => eb.fn.max('id').as('id'))
      .where('workspace_id', '=', workspaceId)
      .where('task_id', '=', taskId)
      .executeTakeFirst();

    return {
      events: rows.map((row) => ({
        id: String(row.id),
        taskId: row.task_id,
        runId: row.run_id,
        // Stored as text so a future type does not fail an old row's read;
        // parsed on the way out so the wire shape stays closed.
        type: taskEventTypeSchema.catch('task.posted').parse(row.type),
        payload: row.payload,
        createdAt: toIso(row.created_at),
      })),
      latestId: newest?.id === null || newest?.id === undefined ? null : String(newest.id),
    };
  }
}

/** Re-exported so Role A does not have to derive the channel name. */
export { workspaceChannel };
