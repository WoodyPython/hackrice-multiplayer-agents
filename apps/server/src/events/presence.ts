import {
  PRESENCE_MAX_PARTICIPANTS, PRESENCE_TTL_MS,
  type Participant,
} from '@app/contracts';

/**
 * Who has a workspace open, held in memory only.
 *
 * Deliberately not a table. Design section 1.3 rules out a persistent
 * participant list, and a durable row would outlive the browser that wrote it —
 * the exact failure mode this has to avoid, because a stale row reads as
 * "someone is here" when nobody is. Losing the whole roster on restart is
 * correct behaviour, not a gap: every live browser re-announces within one
 * heartbeat.
 *
 * One process owns it, matching the single-instance deployment in section 5.3.
 */
export class PresenceRegistry {
  private readonly rooms = new Map<string, Map<string, Participant & {
    lastSeen: number;
    typingSeen?: number;
  }>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns true when the visible roster changed and is worth broadcasting. */
  announce(workspaceId: string, entry: { presenceId: string; name: string; color: string }): boolean {
    let room = this.rooms.get(workspaceId);
    if (!room) this.rooms.set(workspaceId, (room = new Map()));
    const existing = room.get(entry.presenceId);
    // A repeat heartbeat with the same label is the common case and must not
    // wake every other browser in the room.
    if (existing) {
      const unchanged = existing.name === entry.name && existing.color === entry.color;
      existing.lastSeen = this.now();
      existing.name = entry.name;
      existing.color = entry.color;
      return !unchanged;
    }
    if (room.size >= PRESENCE_MAX_PARTICIPANTS) return false;
    room.set(entry.presenceId, { ...entry, since: this.now(), lastSeen: this.now() });
    return true;
  }

  leave(workspaceId: string, presenceId: string): boolean {
    const room = this.rooms.get(workspaceId);
    if (!room?.delete(presenceId)) return false;
    if (!room.size) this.rooms.delete(workspaceId);
    return true;
  }

  /** Updates typing once per typing burst; it is never persisted. */
  setTyping(workspaceId: string, presenceId: string, taskId: string | null): boolean {
    const entry = this.rooms.get(workspaceId)?.get(presenceId);
    if (!entry) return false;
    const changed = entry.typingTaskId !== (taskId ?? undefined);
    if (taskId) {
      entry.typingTaskId = taskId;
      entry.typingSeen = this.now();
    } else {
      delete entry.typingTaskId;
      delete entry.typingSeen;
    }
    return changed;
  }

  list(workspaceId: string): Participant[] {
    const room = this.rooms.get(workspaceId);
    if (!room) return [];
    const cutoff = this.now() - PRESENCE_TTL_MS;
    return [...room.values()]
      .filter((entry) => entry.lastSeen > cutoff)
      .sort((a, b) => a.since - b.since || a.presenceId.localeCompare(b.presenceId))
      .map(({ lastSeen: _lastSeen, typingSeen, ...participant }) => {
        if (typingSeen !== undefined && typingSeen <= this.now() - 5_000)
          delete participant.typingTaskId;
        return participant;
      });
  }

  /** Drops silent browsers; returns the workspaces whose roster changed. */
  sweep(): string[] {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    const changed: string[] = [];
    for (const [workspaceId, room] of this.rooms) {
      let dropped = false;
      for (const [presenceId, entry] of room) {
        if (entry.lastSeen <= cutoff) {
          room.delete(presenceId);
          dropped = true;
        }
      }
      for (const entry of room.values()) {
        if (entry.typingSeen !== undefined && entry.typingSeen <= this.now() - 5_000) {
          delete entry.typingTaskId;
          delete entry.typingSeen;
          dropped = true;
        }
      }
      if (dropped) changed.push(workspaceId);
      if (!room.size) this.rooms.delete(workspaceId);
    }
    return changed;
  }
}
