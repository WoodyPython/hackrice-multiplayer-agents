import { useEffect, useState } from "react";
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
            body: JSON.stringify({ presenceId, name, color }),
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
  }, [workspaceId, presenceId, name, color]);

  return participants;
}
