import { useEffect, useRef, useState } from "react";
import {
  PRESENCE_HEARTBEAT_MS,
  presenceRosterSchema,
  type Participant,
} from "@app/contracts";
import { subscribePresence } from "./realtime";

/** One call when a typing burst starts and one when it stops; no per-key traffic. */
export function setPresenceTyping(
  workspaceId: string,
  presenceId: string,
  taskId: string | null,
): void {
  try {
    void fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/presence/${encodeURIComponent(presenceId)}/typing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
        keepalive: taskId === null,
      },
    ).catch(() => {});
  } catch {
    /* Typing presence is best-effort and expires server-side. */
  }
}

/**
 * Who else has this workspace open right now.
 *
 * Built on the existing same-origin SSE room rather than a second realtime
 * transport. §5.1 names Supabase Realtime as the notification transport and
 * also says a realtime project is optional, with the client falling back to
 * what the frontend already has — and what it already has is this stream. A
 * browser-side Supabase client would mean a new dependency, a second socket,
 * and the publishable key in the bundle, to deliver the same roster the room
 * we are already connected to can carry.
 *
 * The roster is a display, never a permission input. §1.3: these are
 * "unverified display labels" that must never approve anything.
 */
export function usePresence(
  workspaceId: string | undefined,
  me: { presenceId: string; name: string; color: string },
): Participant[] {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const { presenceId, name, color } = me;

  /**
   * The label, read by the heartbeat without being a dependency of it.
   *
   * The subscription below used to be keyed on `name` and `color` too, which
   * meant a rename did far more than rename: the cleanup ran, which closed the
   * shared event stream AND sent the "I have left" DELETE, so changing your own
   * display name made you blink out of everyone else's roster and dropped your
   * refresh stream on the way. Signing in makes that happen on every page load,
   * because the account's name replaces the guest label.
   *
   * A ref, so the heartbeat always sends the current label while the stream it
   * travels on stays up.
   */
  const label = useRef({ name, color });
  label.current = { name, color };

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    let stopped = false;

    const announce = async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/presence`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            // No host flag: the server derives it from membership.
            body: JSON.stringify({ presenceId, ...label.current }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return;
        const roster = presenceRosterSchema.safeParse(await response.json());
        // The POST answers with the roster, so the panel is populated on the
        // first beat instead of waiting for someone else to arrive.
        if (roster.success && !stopped) setParticipants(roster.data.participants);
      } catch {
        // Presence is ornamental. A failed heartbeat must never surface as an
        // error on a screen where real work is happening.
      }
    };

    void announce();
    const timer = setInterval(() => void announce(), PRESENCE_HEARTBEAT_MS);
    const unsubscribe = subscribePresence(workspaceId, (roster) => {
      if (!stopped) setParticipants(roster.participants);
    });

    // Best-effort departure so the room updates immediately rather than after
    // the server's sweep. keepalive lets it survive the unload.
    const leave = () => {
      // Both arms matter: fetch can throw synchronously on a bad URL and can
      // reject asynchronously on a dead network, and a `void`ed promise escapes
      // the try block entirely -- which surfaced as an unhandled rejection on
      // unload. The TTL sweep is the guarantee; this is only the fast path.
      try {
        void fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/presence/${presenceId}`,
          { method: "DELETE", keepalive: true },
        ).catch(() => {});
      } catch {
        /* Nothing to retry: the sweep removes this browser either way. */
      }
    };
    window.addEventListener("pagehide", leave);

    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      controller.abort();
      window.removeEventListener("pagehide", leave);
      leave();
    };
    // Deliberately not keyed on the label. Joining and leaving the room is
    // about this browser being here, which a rename does not change.
  }, [workspaceId, presenceId]);

  /**
   * A rename is an announcement, not a rejoin.
   *
   * Separate effect so it re-posts the roster entry without touching the
   * subscription, the heartbeat, or the departure notice above.
   */
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    void fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presenceId, name, color }),
      signal: controller.signal,
    }).catch(() => {
      // Ornamental, exactly as above: the next heartbeat carries the new label.
    });
    return () => controller.abort();
  }, [workspaceId, presenceId, name, color]);

  return participants;
}
