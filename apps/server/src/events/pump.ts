import type { TaskEventType } from '@app/contracts';
import { taskEventTypeSchema } from '@app/contracts';
import type { Db } from '../db/client.js';
import type { Broadcaster } from './broadcaster.js';

/**
 * B06: broadcasts refresh hints for events that are already durable.
 *
 * Section 11.5: "Persist task events before broadcasting their IDs."
 *
 * This reads that ordering out of the table rather than asking eleven call
 * sites to honour it. Events are appended inside whatever transaction produced
 * them; this sweeps rows newer than its watermark and broadcasts them. Three
 * consequences, and the first is why this shape was chosen over calling
 * broadcast at each site:
 *
 *   A rolled-back transaction broadcasts nothing, automatically. There is no
 *   row to sweep. Broadcasting at the call site would need every site to place
 *   its call after commit, and the one that forgot would announce a state
 *   change that never happened.
 *
 *   Appending stays a pure database operation. Services, including Role C's
 *   ledger, do not need a broadcaster to record an event.
 *
 *   A restart resumes cleanly. The watermark starts at the current maximum, so
 *   history is not replayed — section 11.5 makes missed hints harmless, while
 *   replaying every event in a workspace on boot would be a thundering herd of
 *   refetches.
 *
 * Latency is one sweep interval. Section 5 already specifies polling as the
 * client-side fallback, so this is an optimisation over that, not a
 * dependency of it.
 */

export interface EventPumpDeps {
  db: Db;
  broadcaster: Broadcaster;
  /** Sweep interval. Short, because this is a refresh hint, not a job queue. */
  intervalMs?: number;
  /** Events per sweep, so a burst cannot hold the loop indefinitely. */
  batchSize?: number;
  /**
   * How stale `workspaces.last_activity_at` may get before a sweep rewrites it.
   *
   * Five minutes by default: the value is read by a list ordered in days, and
   * rewriting it per event would turn a refresh hint into a write amplifier.
   */
  activityThrottleMs?: number;
  onError?: (error: unknown) => void;
}

export class TaskEventPump {
  private watermark = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight: Promise<number> | undefined;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly activityThrottleMs: number;

  constructor(private readonly deps: EventPumpDeps) {
    this.intervalMs = deps.intervalMs ?? 400;
    this.batchSize = deps.batchSize ?? 200;
    this.activityThrottleMs = deps.activityThrottleMs ?? 5 * 60 * 1000;
  }

  /**
   * Begins sweeping, from now rather than from the beginning of time.
   *
   * The watermark is set before the first sweep, so events that already existed
   * when the process started are never broadcast. A browser that was connected
   * across the restart refetches on reconnect anyway.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.watermark = await this.currentMax();
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
    // Never hold the process open for a refresh hint.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /**
   * Sweeps once. Exposed so tests do not wait on a timer, and so a caller that
   * knows it just produced an event can shorten the delay.
   */
  flush(): Promise<number> {
    if (!this.inFlight) {
      this.inFlight = this.sweep().finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  private async sweep(): Promise<number> {
    try {
      const rows = await this.deps.db
        .selectFrom('task_events')
        .select(['id', 'workspace_id', 'task_id', 'type'])
        .where('id', '>', this.watermark)
        .orderBy('id')
        .limit(this.batchSize)
        .execute();

      if (rows.length === 0) return 0;

      for (const row of rows) {
        await this.deps.broadcaster.hint({
          workspaceId: row.workspace_id,
          taskId: row.task_id,
          eventType: parseType(row.type),
          eventId: String(row.id),
        });
      }

      await this.touchActivity([...new Set(rows.map((row) => row.workspace_id))]);

      // Advanced only after the batch is sent. A broadcaster that threw would
      // otherwise skip the batch permanently; `hint` is contractually
      // non-throwing, so this is belt and braces rather than the main path.
      this.watermark = Number(rows[rows.length - 1]!.id);
      return rows.length;
    } catch (error) {
      this.deps.onError?.(error);
      return 0;
    }
  }

  /**
   * "Something happened in this workspace", which is what the workspace list
   * sorts by and what retention measures abandonment against.
   *
   * **Here rather than in `appendEvent`, and that is a lock-ordering decision,
   * not a stylistic one.** This codebase locks workspace → task → run → budget;
   * `reviews/service.ts` takes the workspace row first and says so. `appendEvent`
   * runs with the *task* row already locked, by itself and by every caller that
   * appends inside a wider transaction, so an UPDATE on `workspaces` from there
   * would take the two rows in the opposite order from guidance edits and
   * Apply — two paths that each read correctly alone and deadlock together.
   * The pump already runs after commit, outside every caller's transaction,
   * which makes it the one place this can be written with no lock held at all.
   *
   * Throttled in the WHERE clause rather than in memory. A run appends dozens
   * of events; without it every one would rewrite the row, and the process
   * that thinks it knows the last value is the process that is wrong after a
   * restart. Not matching a row is also not taking a lock, so the throttle is
   * what keeps a busy workspace from serializing its own sweeps.
   *
   * Failure is swallowed by the caller's try/catch and costs an ordering
   * timestamp, never a refresh hint.
   */
  private async touchActivity(workspaceIds: string[]): Promise<void> {
    if (workspaceIds.length === 0) return;
    const now = new Date();
    await this.deps.db
      .updateTable('workspaces')
      .set({ last_activity_at: now })
      .where('id', 'in', workspaceIds)
      .where('last_activity_at', '<', new Date(now.getTime() - this.activityThrottleMs))
      .execute();
  }

  /** Test seam: where the pump believes it has reached. */
  get position(): number {
    return this.watermark;
  }

  private async currentMax(): Promise<number> {
    const row = await this.deps.db
      .selectFrom('task_events')
      .select((eb) => eb.fn.max('id').as('id'))
      .executeTakeFirst();
    return row?.id === null || row?.id === undefined ? 0 : Number(row.id);
  }
}

/**
 * The column is text so an unrecognised type from a newer process cannot fail
 * an older one's read. Parsed here so the wire shape stays closed.
 */
function parseType(value: string): TaskEventType {
  return taskEventTypeSchema.catch('task.posted').parse(value);
}
