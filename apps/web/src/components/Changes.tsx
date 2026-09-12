import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  currentReview,
  type CandidateResolution,
  type Review,
  type ReviewDetail,
  type ReviewPreview,
  type TaskDetail,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "./EmptyState";

/**
 * Review and conflict resolution (design §4.6, §10.2, §10.3).
 *
 * The properties that matter here are all about not overstating what is known:
 *
 * **A review has to be asked for.** Nothing prepares one automatically — a task
 * reaches `ready_for_review` when its assignments integrate, and no review row
 * exists until someone requests it. So the absence of a review is reported as
 * "not requested yet", never as "no changes".
 *
 * **Conflict sides are named.** §10.2: "'Current' must identify whether it
 * means the human draft or approved workspace; never label both simply
 * 'ours'." Every side carries which of the three sources it is.
 *
 * **Apply is the server's decision.** The button is hidden without an owner
 * key, and that is presentation only — the server checks the key on every
 * apply, and §4.6 says hiding a button is insufficient. It also sends the
 * candidate SHA it was looking at, so a review that moved underneath is
 * refused rather than silently applying something else.
 */
export function Changes({
  task,
  isOwner,
  onApplied,
  staleSignal,
}: {
  task: TaskDetail;
  isOwner: boolean;
  onApplied: () => void;
  /**
   * Identifies the most recent `review.stale` event on this task (§7.6).
   *
   * The task page already polls the durable event record, so this screen learns
   * that someone kept typing without opening a second polling loop of its own.
   * Before this it only found out by failing an Apply, which §4.7 rules out:
   * the button is supposed to be *disabled* with Refresh offered, which means
   * knowing before the click rather than after.
   */
  staleSignal?: string;
}) {
  const { api } = useBrowser();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const applyId = useRef(crypto.randomUUID());
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const list = await api.listTaskReviews(
          task.workspaceId,
          task.id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setReviews(list);
        const current = currentReview(list);
        // A building review has no candidate SHA, and reading its detail means
        // reading a Git artifact that does not exist yet.
        setDetail(
          current && current.status !== "building"
            ? await api.readReview(
                task.workspaceId,
                current.id,
                controller.signal,
              )
            : null,
        );
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [api, task.workspaceId, task.id, nonce, staleSignal]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await run();
      reload();
    } catch (error) {
      setFailure(apiMessage(error));
      // A stale review means our copy is behind, not that the action was wrong.
      if (error instanceof ApiError && error.code === "REVIEW_STALE") reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading && reviews === null) return <p role="status">Loading review…</p>;

  const current = reviews ? currentReview(reviews) : null;

  if (!current)
    return (
      <>
        {failure && (
          <p role="alert" className="error">
            {failure}
          </p>
        )}
        <EmptyState
          title="No review has been requested yet"
          action={
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(() => api.prepareReview(task.workspaceId, task.id))
              }
            >
              {busy ? "Preparing…" : "Prepare review"}
            </button>
          }
        >
          Preparing a review combines the approved files, the shared draft, and
          any agent output into one candidate you can read before deciding.
          Nothing is published by preparing it.
        </EmptyState>
      </>
    );

  return (
    <div className="review">
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}

      <header className="review-head">
        <span className={`status status-${current.status}`}>
          {current.status}
        </span>
        <small className="muted">
          Against task version {current.source.taskVersion}
        </small>
      </header>

      {current.status === "building" && (
        <p role="status">
          This candidate is still being built. Reopen the tab in a moment.
        </p>
      )}

      {current.status === "stale" && (
        <div className="notice" role="status">
          <h3>This review is out of date</h3>
          <p>
            Someone has typed in the shared draft, or another task was applied,
            since this candidate was built. Applying it would publish something
            that no longer matches the workspace.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void act(() => api.prepareReview(task.workspaceId, task.id))
            }
          >
            {busy ? "Refreshing…" : "Refresh review"}
          </button>
        </div>
      )}

      {current.status === "applied" && (
        <div className="notice" role="status">
          <h3>These changes were applied</h3>
          <p>
            This is the record of what went onto the approved files. Nothing
            further is needed.
          </p>
        </div>
      )}

      {detail && (
        <>
          {detail.conflicts.length > 0 && (
            <Conflicts
              detail={detail}
              busy={busy}
              onResolve={(resolutions) =>
                void act(() =>
                  api.resolveReview(task.workspaceId, current.id, {
                    expectedCandidateSha: detail.candidateSha,
                    resolutions,
                  }),
                )
              }
            />
          )}

          <section className="changed-files">
            <h3>
              {detail.changedFiles.length === 0
                ? "No file changes"
                : `${detail.changedFiles.length} changed file${detail.changedFiles.length === 1 ? "" : "s"}`}
            </h3>
            {detail.changedFiles.length === 0 ? (
              <p className="muted">
                This candidate makes no change to any file. That is a real
                outcome, not an error — the work may have been answered in
                discussion.
              </p>
            ) : (
              detail.changedFiles.map((file) => (
                <ChangedFile
                  key={file.path}
                  file={file}
                  workspaceId={task.workspaceId}
                  reviewId={current.id}
                />
              ))
            )}
          </section>

          {/* §13.2: generated code is never executed as part of review. */}
          <p className="muted">
            Generated content was not executed. Read it as text.
          </p>

          {current.status === "ready" &&
            (isOwner ? (
              <div className="apply">
                <button
                  className="primary"
                  disabled={busy || detail.conflicts.length > 0}
                  onClick={() =>
                    void act(async () => {
                      await api.applyReview(
                        task.workspaceId,
                        current.id,
                        detail.candidateSha,
                        applyId.current,
                      );
                      applyId.current = crypto.randomUUID();
                      onApplied();
                    })
                  }
                >
                  {busy ? "Applying…" : "Apply these changes"}
                </button>
                {detail.conflicts.length > 0 && (
                  <small className="muted">
                    Resolve the conflicts above before applying.
                  </small>
                )}
              </div>
            ) : (
              <p className="muted">
                Only the workspace owner can apply changes. You can still
                discuss them on the task.
              </p>
            ))}
        </>
      )}
    </div>
  );
}

/** How each conflicting side is named. §10.2 forbids calling any of them "ours". */
const SIDE_LABEL: Record<string, string> = {
  human_draft: "What people wrote in the shared draft",
  agent_result: "What the agents produced",
  approved_main: "What is currently approved",
  combined_task: "The combined result so far",
};

function Conflicts({
  detail,
  busy,
  onResolve,
}: {
  detail: ReviewDetail;
  busy: boolean;
  onResolve: (resolutions: CandidateResolution[]) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const ready = detail.conflicts.every((conflict) => choices[conflict.path]);

  return (
    <section className="conflicts">
      <h3>
        {detail.conflicts.length} file
        {detail.conflicts.length === 1 ? "" : "s"} need a decision
      </h3>
      <p className="muted">
        These files were changed in more than one place. Choose which version to
        keep. Resolving builds a new candidate — it does not overwrite anything.
      </p>
      {detail.conflicts.map((conflict) => (
        <fieldset className="conflict" key={conflict.path}>
          <legend>
            <code className="path">{conflict.path}</code>
          </legend>
          {conflict.sides.map((side) => (
            <label className="conflict-side" key={side.side}>
              <input
                type="radio"
                name={`conflict:${conflict.path}`}
                checked={choices[conflict.path] === side.side}
                onChange={() =>
                  setChoices((current) => ({
                    ...current,
                    [conflict.path]: side.side,
                  }))
                }
              />
              <span>
                {SIDE_LABEL[side.side] ?? side.side}
                {side.text === null && (
                  <small> · this version deletes the file</small>
                )}
              </span>
              {side.text !== null && (
                <pre className="side-text">{side.text}</pre>
              )}
            </label>
          ))}
        </fieldset>
      ))}
      <button
        className="primary"
        disabled={busy || !ready}
        onClick={() =>
          onResolve(
            detail.conflicts.map((conflict) => ({
              path: conflict.path,
              choice: choices[conflict.path] as CandidateResolution["choice"],
            })),
          )
        }
      >
        {busy ? "Resolving…" : "Use these versions"}
      </button>
      {!ready && (
        <small className="muted">Choose a version for every file above.</small>
      )}
    </section>
  );
}

/**
 * One changed file: its diff, and for Markdown its rendered result (§4.6).
 *
 * The preview is fetched only when opened and only for Markdown, which is what
 * §4.6 asks for. It matters most in exactly the case A08 names — a multi-file
 * result — because a diff of prose is hard to judge and a rendered version is
 * not.
 *
 * The text is rendered as text. §13.2 keeps generated content inert and §13.3
 * never lets stored content become markup on this origin, so this deliberately
 * does not run a Markdown-to-HTML pass: headings and emphasis are shown as the
 * source that produced them, which is honest and cannot execute.
 */
function ChangedFile({
  file,
  workspaceId,
  reviewId,
}: {
  file: ReviewDetail["changedFiles"][number];
  workspaceId: string;
  reviewId: string;
}) {
  const { api } = useBrowser();
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const markdown = /\.(md|markdown)$/i.test(file.path);

  useEffect(() => {
    if (!open || !markdown || preview || file.changeKind === "deleted") return;
    const controller = new AbortController();
    void api
      .previewReview(workspaceId, reviewId, file.path, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      });
    return () => controller.abort();
  }, [api, open, markdown, preview, workspaceId, reviewId, file.path, file.changeKind]);

  return (
    <details
      className="file-diff"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>
        <code className="path">{file.path}</code>
        <span className={`change-kind ${file.changeKind}`}>{file.changeKind}</span>
      </summary>
      <pre className="diff">{file.diff}</pre>
      {markdown && file.changeKind !== "deleted" && (
        <div className="preview">
          <h4>How this file would read</h4>
          {failure ? (
            <p role="alert" className="error">
              {failure}
            </p>
          ) : preview ? (
            <pre className="preview-text">{preview.text}</pre>
          ) : (
            <p role="status">Loading preview…</p>
          )}
        </div>
      )}
    </details>
  );
}
