import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { HistoryEntry } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "../components/EmptyState";

/**
 * Applied changes and the tasks they came from (design §4.1).
 *
 * Built on apply operations rather than reviews, which is what lets this screen
 * be honest about the awkward cases. §10.5 writes that row *before* the ref
 * moves and settles it afterwards, so an operation still sitting at `pending`
 * after a restart is a real state the workspace is in — and a `failed` or
 * `ambiguous` one is exactly what someone opens History to find. Listing only
 * successes would make a stuck apply invisible in the one screen meant to
 * explain what happened.
 *
 * No file lists here. Naming changed paths means reading each candidate out of
 * Git, one read per row; the task and the commit are enough to find the detail,
 * and the review still holds it.
 */
export function History({ workspaceId }: { workspaceId: string }) {
  const { api } = useBrowser();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const base = `/w/${workspaceId}`;

  useEffect(() => {
    const controller = new AbortController();
    void api
      .listHistory(workspaceId, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setEntries(rows);
          setFailure(null);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      });
    return () => controller.abort();
  }, [api, workspaceId, nonce]);

  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">A record of progress</span>
          <h1>History</h1>
          <p>Changes that were applied to the approved files, newest first.</p>
        </div>
      </header>

      {failure && (
        <div role="alert">
          <p className="error">{failure}</p>
          <button onClick={reload}>Try again</button>
        </div>
      )}

      {entries === null ? (
        <p role="status">Loading history…</p>
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nothing has been applied yet"
          action={
            <Link className="button" to={base}>
              Back to the board
            </Link>
          }
        >
          When an owner applies a reviewed change, it appears here with the task
          it came from.
        </EmptyState>
      ) : (
        <ol className="history">
          {entries.map((entry) => (
            <li className={`history-entry apply-${entry.status}`} key={entry.applyOperationId}>
              <div className="history-head">
                <Link to={`${base}/tasks/${entry.taskId}?tab=Changes`}>
                  {entry.taskTitle}
                </Link>
                <span className={`status apply-${entry.status}`}>
                  {LABEL[entry.status]}
                </span>
              </div>
              <p className="muted">
                {entry.taskKind === "manual_edit"
                  ? "Written by hand"
                  : "Produced with agents"}{" "}
                · <code className="path">{entry.candidateSha.slice(0, 8)}</code>
                {entry.settledAt
                  ? ` · ${new Date(entry.settledAt).toLocaleString()}`
                  : " · not settled"}
              </p>
              {entry.status !== "applied" && (
                <p className="muted">{EXPLAIN[entry.status]}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

const LABEL: Record<HistoryEntry["status"], string> = {
  applied: "Applied",
  pending: "In progress",
  failed: "Did not apply",
  ambiguous: "Needs checking",
};

/**
 * Why a non-applied row is here. §10.5's whole point is that these states are
 * distinguishable — an apply that never ran and one whose outcome is unknown
 * need different responses, so they must not read the same.
 */
const EXPLAIN: Record<HistoryEntry["status"], string> = {
  applied: "",
  pending:
    "This apply was recorded but has not reported an outcome. If it stays here, the server was interrupted mid-apply.",
  failed:
    "The change was not published. The approved files are unchanged, and the review can be refreshed and applied again.",
  ambiguous:
    "The outcome could not be determined, so nothing further was attempted automatically. Someone needs to compare the approved files against this commit before retrying.",
};
