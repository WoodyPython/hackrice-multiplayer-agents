import type { TaskEvent, TaskStatus } from "@app/contracts";

/**
 * Why the current attempt ended up where it did (design §4.7).
 *
 * C06 emits an `agent.waiting` event with `payload.phase === 'start'` and a
 * stable `reason` code at each decision point of a Start. The codes are the
 * only explanation available — §13.3 keeps provider and filesystem text off the
 * browser entirely, so there is no message to fall back on, and inventing one
 * would be worse than the code.
 *
 * Two rules from the interface notes are obeyed here:
 *
 * **The code is never the primary message.** Each known reason maps to a
 * sentence this file owns. An unknown code falls through to a generic
 * explanation plus the saved-work affordance, because the set of codes is
 * explicitly not closed and a new one must not render as a blank panel.
 *
 * **`omitted` is surfaced.** It is the single most important payload here and
 * the easiest to skip: it lists selected inputs that could not be captured, so
 * without it a contributor believes the agents read a document they never saw.
 */

type StartPayload = {
  phase?: unknown;
  reason?: unknown;
  paths?: unknown;
  omitted?: unknown;
};

const COPY: Record<string, { title: string; detail: string }> = {
  snapshot_conflict: {
    title: "The approved files and the shared draft could not be combined",
    detail:
      "This attempt stopped before any agent ran, so nothing was spent. Resolve the overlap in the files below, then start again.",
  },
  integration_conflict: {
    title: "Agent outputs overlapped and could not be combined",
    detail:
      "Each agent's work is saved. The files below need an explicit decision before this can go forward.",
  },
  assignments_incomplete: {
    title: "At least one assignment did not finish",
    detail:
      "Work that did complete is preserved and listed under Agents. Retrying starts a fresh attempt from the saved state.",
  },
  task_version_changed: {
    title: "The requirements changed while this attempt was starting",
    detail:
      "The attempt was stopped rather than run against requirements nobody approved. Start again to use the current version.",
  },
  guidance_version_changed: {
    title: "Workspace guidance changed while this attempt was starting",
    detail: "Start again to run against the current guidance.",
  },
  model_configuration: {
    title: "No model provider is configured on the server",
    detail:
      "This is a server setup issue, not something to retry. Agents cannot run until a provider key is present.",
  },
};

/** Reasons that are progress, not failure — never shown as an outcome. */
const INFORMATIONAL = new Set(["context_captured", "retry_plan_reused"]);

export function RunOutcome({
  events,
  status,
  runId,
}: {
  events: TaskEvent[];
  status: TaskStatus;
  runId?: string;
}) {
  const starts = events.filter(
    (event) =>
      (!runId || event.runId === runId) &&
      event.type === "agent.waiting" &&
      (event.payload as StartPayload).phase === "start",
  );
  if (starts.length === 0) return null;

  const capture = [...starts]
    .reverse()
    .find(
      (event) => (event.payload as StartPayload).reason === "context_captured",
    );
  const omitted = strings((capture?.payload as StartPayload | undefined)?.omitted);

  const outcome = [...starts]
    .reverse()
    .find((event) => {
      const reason = (event.payload as StartPayload).reason;
      return typeof reason === "string" && !INFORMATIONAL.has(reason);
    });
  const reason =
    outcome && typeof (outcome.payload as StartPayload).reason === "string"
      ? ((outcome.payload as StartPayload).reason as string)
      : null;
  const paths = strings((outcome?.payload as StartPayload | undefined)?.paths);
  const copy = reason ? COPY[reason] : undefined;

  // A settled attempt whose reason we do not recognise still deserves an
  // explanation; a running one does not need an outcome panel at all.
  const settled = !["posted", "planning", "working", "needs_input"].includes(
    status,
  );

  return (
    <>
      {omitted.length > 0 && (
        <div className="notice" role="status">
          <h3>Some selected inputs were not included</h3>
          <p>
            These could not be read when the attempt started, so the agents did
            not see them. A material may have been removed, or a path may not
            exist on the approved branch.
          </p>
          <ul className="file-list">
            {omitted.map((item) => (
              <li key={item}>
                <code className="path">{item}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {reason && settled && (
        <div className="notice outcome" role="status">
          <h3>{copy?.title ?? "This attempt did not complete"}</h3>
          <p>
            {copy?.detail ??
              "Saved work is preserved and listed under Agents. You can retry from here."}
          </p>
          {paths.length > 0 && (
            <ul className="file-list">
              {paths.map((path) => (
                <li key={path}>
                  <code className="path">{path}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** Payloads are `Record<string, unknown>`; take only what is actually strings. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
