import { useEffect, useState } from "react";
import { Users, X } from "lucide-react";
import type { Participant } from "@app/contracts";
import { cn } from "../lib/utils";

/**
 * Who has this workspace open, as a pull-out from the right.
 *
 * The left is the navigation sidebar, so this opens from the other side, and
 * it is a slide-over rather than a permanent column because it answers a
 * question people ask occasionally ("is anyone else here?") rather than one
 * they read continuously.
 *
 * Two honesty constraints, both from §1.3:
 *
 * **These are display labels, not identities.** They are self-chosen and
 * unverified, so the panel says so rather than implying a signed-in roster.
 * Nothing reads this list to decide what anyone may do.
 *
 * **Presence is live, not a membership record.** Someone who closes the tab
 * disappears. The panel therefore describes the present moment, never "members
 * of this workspace", which would claim a durable list that does not exist.
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = [...parts[0]!][0] ?? "?";
  const last = parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function Avatar({
  participant,
  size = "default",
}: {
  participant: Participant;
  size?: "sm" | "default";
}) {
  return (
    <span
      aria-hidden="true"
      // The colour is validated as a six-digit hex in the contract, so it can
      // only ever be a colour -- never arbitrary CSS from another browser.
      style={{ backgroundColor: participant.color }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold text-white ring-2 ring-background",
        size === "sm" ? "size-6 text-[9.5px]" : "size-8 text-[11px]",
      )}
    >
      {/* Stacked avatars overlap, which clips the second letter; the small
          size therefore carries one initial and the full list carries two. */}
      {size === "sm" ? initials(participant.name).slice(0, 1) : initials(participant.name)}
    </span>
  );
}

export function PresencePanel({
  participants,
  selfPresenceId,
}: {
  participants: Participant[];
  selfPresenceId: string;
}) {
  const [open, setOpen] = useState(false);
  const count = participants.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card py-1 pr-2.5 pl-2 transition-colors hover:bg-muted"
      >
        {count > 0 ? (
          <span className="flex -space-x-2">
            {participants.slice(0, 3).map((participant) => (
              <Avatar key={participant.presenceId} participant={participant} size="sm" />
            ))}
          </span>
        ) : (
          <Users aria-hidden="true" className="size-4 text-muted-foreground" />
        )}
        <span className="text-[12px] font-medium tabular-nums">{count}</span>
        <span className="sr-only">
          {count === 1 ? "1 person has" : `${count} people have`} this workspace
          open. Open the list.
        </span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-navy-950/40 backdrop-blur-[2px] animate-[fade_0.25s_ease-out_both]"
          />
          <aside
            aria-label="Who is here"
            className="absolute inset-y-0 right-0 flex w-[300px] max-w-[86vw] flex-col border-l border-border bg-card shadow-lg animate-[fade_0.25s_ease-out_both]"
          >
            <header className="flex items-start gap-3 border-b border-border p-4">
              <div className="min-w-0 flex-1">
                <h2 className="text-[14px] font-semibold tracking-tight">
                  Here right now
                </h2>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  Everyone with this workspace open.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X aria-hidden="true" className="size-4" />
                <span className="sr-only">Close</span>
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {count === 0 ? (
                <p className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">
                  Nobody else is here at the moment.
                </p>
              ) : (
                <ul className="space-y-px">
                  {participants.map((participant) => (
                    <li
                      key={participant.presenceId}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-2"
                    >
                      <Avatar participant={participant} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                        {participant.name}
                      </span>
                      {participant.presenceId === selfPresenceId && (
                        <span className="shrink-0 text-[10.5px] text-muted-foreground">
                          you
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <footer className="border-t border-border p-4">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Names are chosen in each person's own browser and are not
                verified. This list is who is connected now — it is not a
                membership record, and it grants nobody anything.
              </p>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
