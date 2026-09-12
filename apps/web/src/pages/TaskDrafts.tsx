import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, uuidSchema, type DraftFile } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "../components/EmptyState";

const SharedEditor = lazy(() =>
  import("../components/SharedEditor").then((module) => ({
    default: module.SharedEditor,
  })),
);

/**
 * The collaborative editor screen (design §4.4, §2.5).
 *
 * §4.4's control list is the specification for this page, and two of its
 * entries carry meaning that is easy to flatten into the same word:
 *
 * **Saved and Checkpointed are different things.** "Saved" means the server
 * acknowledged the text; "Checkpointed" means it was captured into Git. Neither
 * means approved. Capture takes the acknowledged text, so checkpointing with
 * unsent edits in the buffer would commit a version nobody has seen — which is
 * why the action waits for Saved rather than racing it.
 *
 * **A checkpoint is per task, not per file.** Capture takes every active
 * document in the task at once, so the control belongs to the page rather than
 * to whichever file the selector happens to be showing.
 */
export function TaskDrafts({ workspaceId }: { workspaceId: string }) {
  const { taskId } = useParams();
  const { api } = useBrowser();
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("loading");
  const [retry, setRetry] = useState(0);
  const [saved, setSaved] = useState(false);
  const [checkpoint, setCheckpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const valid = uuidSchema.safeParse(taskId).success;
  const reload = useCallback(() => setRetry((value) => value + 1), []);

  useEffect(() => {
    if (!valid || !taskId) {
      setStatus("missing");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    void api
      .listTaskDrafts(workspaceId, taskId, controller.signal)
      .then((files) => {
        if (controller.signal.aborted) return;
        setDrafts(files);
        setSelected((current) =>
          files.some((file) => file.id === current)
            ? current
            : (files[0]?.id ?? ""),
        );
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus(
          error instanceof ApiError && error.code === "TASK_NOT_FOUND"
            ? "missing"
            : "error",
        );
      });
    return () => controller.abort();
  }, [api, workspaceId, taskId, retry, valid]);

  const draft = drafts.find((file) => file.id === selected);
  const base = `/w/${workspaceId}`;

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await run();
    } catch (error) {
      setFailure(apiMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* §4.4 requires a link back to the task, not to the workspace: the task
          is where the discussion and the review of this text live. */}
      <Link className="back-link" to={valid ? `${base}/tasks/${taskId}` : base}>
        ← Back to the task
      </Link>
      <header className="page-heading">
        <div>
          <span className="eyebrow">Shared editing</span>
          <h1>Shared drafts</h1>
          <p>
            Everyone with the workspace link edits this text together. Changes
            here are not approved until a review is applied.
          </p>
        </div>
      </header>

      {status === "loading" ? (
        <p role="status">Loading drafts…</p>
      ) : status !== "ready" ? (
        <EmptyState
          title={
            status === "missing" ? "Task not found" : "Could not load drafts"
          }
          action={<button onClick={reload}>Try again</button>}
        >
          Check the editing link or try again.
        </EmptyState>
      ) : !draft ? (
        <EmptyState title="No shared drafts yet">
          This task has no open documents. Open one from Files with Edit
          together.
        </EmptyState>
      ) : (
        <>
          <div className="editor-toolbar">
            <label>
              Document
              <select
                value={selected}
                onChange={(event) => {
                  // Switching remounts the binding, so unsent text would be
                  // lost rather than merged.
                  if (
                    saved ||
                    window.confirm(
                      "This draft has unsaved changes. Switch and discard those changes?",
                    )
                  ) {
                    setSaved(false);
                    setSelected(event.target.value);
                  }
                }}
              >
                {drafts.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.path}
                  </option>
                ))}
              </select>
            </label>

            <div className="editor-actions">
              <button
                disabled={busy || !saved}
                onClick={() =>
                  void act(async () => {
                    const capture = await api.checkpointDrafts(
                      workspaceId,
                      taskId!,
                    );
                    setCheckpoint(capture.checkpointSha);
                  })
                }
              >
                {busy ? "Working…" : "Checkpoint"}
              </button>
              <button
                className="primary"
                disabled={busy || !saved}
                onClick={() =>
                  void act(async () => {
                    await api.prepareReview(workspaceId, taskId!);
                    navigate(`${base}/tasks/${taskId}?tab=Changes`);
                  })
                }
              >
                {busy ? "Working…" : "Request review"}
              </button>
            </div>
          </div>

          <p className="editor-state" aria-live="polite">
            {!saved && (
              <span className="unsaved">
                Unsaved — Checkpoint and Request review wait until the server
                has the text.
              </span>
            )}
            {checkpoint ? (
              <span className="checkpointed">
                Checkpointed in Git at{" "}
                <code className="path">{checkpoint.slice(0, 8)}</code>. Captured,
                not approved.
              </span>
            ) : (
              <span className="muted">
                Not checkpointed yet in this session.
              </span>
            )}
          </p>

          {failure && (
            <p role="alert" className="error">
              {failure}
            </p>
          )}

          <Suspense fallback={<p role="status">Loading editor…</p>}>
            <SharedEditor
              key={`${draft.id}:${draft.epoch}`}
              room={{
                workspaceId,
                taskId: taskId!,
                draftFileId: draft.id,
                epoch: draft.epoch,
              }}
              draft={draft}
              onSaved={setSaved}
            />
          </Suspense>
        </>
      )}
    </>
  );
}
