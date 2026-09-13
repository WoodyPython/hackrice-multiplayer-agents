import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, GitCompare, ShieldCheck } from "lucide-react";
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
import { humanizeStatus, toneFor } from "../board";
import { cn } from "../lib/utils";
import { EmptyState } from "./EmptyState";
import { Badge, Dot } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/field";
import { ErrorText, Notice, Path, Skeleton } from "./ui/misc";

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
  const appliedReview = useRef<string | null>(null);
  const readEpoch = useRef(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      const epoch = readEpoch.current;
      try {
        const list = await api.listTaskReviews(
          task.workspaceId,
          task.id,
          controller.signal,
        );
        if (controller.signal.aborted || epoch !== readEpoch.current) return;
        const reconciled = appliedReview.current
          ? list.map((item) => item.id === appliedReview.current ? { ...item, status: "applied" as const } : item)
          : list;
        setReviews(reconciled);
        const current = currentReview(reconciled);
        // A building review has no candidate SHA, and reading its detail means
        // reading a Git artifact that does not exist yet.
        const nextDetail = current && current.status !== "building"
            ? await api.readReview(
                task.workspaceId,
                current.id,
                controller.signal,
              )
            : null;
        if (controller.signal.aborted || epoch !== readEpoch.current) return;
        setDetail(nextDetail);
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [api, task.workspaceId, task.id, nonce, staleSignal, task.status, task.activeRunId]);

  async function act<T>(run: () => Promise<T>, commit?: (result: T) => void) {
    readEpoch.current += 1;
    setBusy(true);
    setFailure(null);
    try {
      const result = await run();
      commit?.(result);
      reload();
    } catch (error) {
      setFailure(apiMessage(error));
      // A stale review means our copy is behind, not that the action was wrong.
      if (error instanceof ApiError && error.code === "REVIEW_STALE") reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading && reviews === null)
    return (
      <div className="space-y-3">
        <p role="status" className="sr-only">
          Loading review…
        </p>
        <Skeleton aria-hidden="true" className="h-5 w-40" />
        <Skeleton aria-hidden="true" className="h-24" />
      </div>
    );

  const current = reviews ? currentReview(reviews) : null;

  if (!current)
    return (
      <>
        {failure && <ErrorText role="alert">{failure}</ErrorText>}
        <EmptyState
          title="No review has been requested yet"
          icon={GitCompare}
          action={
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => api.prepareReview(task.workspaceId, task.id),
                  (next) => {
                    setReviews((current) => [next.review, ...(current ?? []).filter((item) => item.id !== next.review.id)]);
                    setDetail(next);
                  },
                )
              }
            >
              {busy ? "Preparing…" : "Prepare review"}
            </Button>
          }
        >
          Preparing a review combines the approved files, the shared draft, and
          any agent output into one candidate you can read before deciding.
          Nothing is published by preparing it.
        </EmptyState>
      </>
    );

  const tone = toneFor(current.status);

  return (
    <div className="space-y-5">
      {failure && <ErrorText role="alert">{failure}</ErrorText>}

      <header className="flex flex-wrap items-center gap-2.5 border-b border-border pb-3.5">
        <Badge tone={tone}>
          <Dot tone={tone} live={current.status === "building"} />
          {humanizeStatus(current.status)}
        </Badge>
      </header>

      {current.status === "building" && (
        <p role="status" className="text-[13px] text-muted-foreground">
          This candidate is still being built. Reopen the tab in a moment.
        </p>
      )}

      {current.status === "stale" && (
        <Notice role="status" tone="warn" title="This review is out of date">
          <p>
            Someone has typed in the shared draft, or another task was applied,
            since this candidate was built. Applying it would publish something
            that no longer matches the workspace.
          </p>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(
                () => api.prepareReview(task.workspaceId, task.id),
                (next) => {
                  setReviews((items) => [next.review, ...(items ?? []).filter((item) => item.id !== next.review.id)]);
                  setDetail(next);
                },
              )
            }
          >
            {busy ? "Refreshing…" : "Refresh review"}
          </Button>
        </Notice>
      )}

      {current.status === "applied" && (
        <Notice role="status" title="These changes were applied">
          <p>
            {task.status === "awaiting_confirmation"
              ? "Your changes are saved. Anyone can choose Mark as Complete above."
              : "These changes are saved in your workspace. You can find them in History anytime."}
          </p>
          {task.activeRunId === null && (task.status === "ready_for_review" || (task.kind === "manual_edit" && task.status === "posted")) && (
            <Button disabled={busy} onClick={() => void act(() => api.prepareReview(task.workspaceId, task.id), (next) => {
              setReviews((items) => [next.review, ...(items ?? []).filter((item) => item.id !== next.review.id)]);
              setDetail(next);
            })}>
              Prepare new review
            </Button>
          )}
        </Notice>
      )}

      {detail && (
        <>
          {detail.conflicts.length > 0 && (
            <Conflicts
              detail={detail}
              busy={busy}
              onResolve={(resolutions) =>
                void act(
                  () => api.resolveReview(task.workspaceId, current.id, {
                      expectedCandidateSha: detail.candidateSha,
                      resolutions,
                    }),
                  (next) => {
                    setReviews((items) => (items ?? []).map((item) => item.id === next.review.id ? next.review : item));
                    setDetail(next);
                  },
                )
              }
            />
          )}

          <section className="space-y-2.5">
            <h3 className="text-[13px] font-semibold tracking-tight">
              {detail.changedFiles.length === 0
                ? "No file changes"
                : `${detail.changedFiles.length} changed file${detail.changedFiles.length === 1 ? "" : "s"}`}
            </h3>
            {detail.changedFiles.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                This candidate makes no change to any file. That is a real
                outcome, not an error — the work may have been answered in
                discussion.
              </p>
            ) : (
              <div className="grid gap-2">
                {detail.changedFiles.map((file) => (
                  <ChangedFile
                    key={file.path}
                    file={file}
                    workspaceId={task.workspaceId}
                    reviewId={current.id}
                  />
                ))}
              </div>
            )}
          </section>

          {/* §13.2: generated code is never executed as part of review. */}
          <p className="text-[11.5px] text-muted-foreground">
            Generated content was not executed. Read it as text.
          </p>

          {current.status === "ready" &&
            (isOwner ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/30 p-4">
                <Button
                  variant="primary"
                  disabled={busy || detail.conflicts.length > 0}
                  onClick={() =>
                    void act(async () => {
                      const result = await api.applyReview(
                        task.workspaceId,
                        current.id,
                        detail.candidateSha,
                        applyId.current,
                      );
                      if (result.status !== "applied") return;
                      appliedReview.current = current.id;
                      setReviews((items) => (items ?? []).map((item) =>
                        item.id === current.id ? { ...item, status: "applied" as const, updatedAt: new Date().toISOString() } : item,
                      ));
                      applyId.current = crypto.randomUUID();
                      onApplied();
                    })
                  }
                >
                  <ShieldCheck aria-hidden="true" />
                  {busy ? "Applying…" : "Apply these changes"}
                </Button>
                {detail.conflicts.length > 0 && (
                  <small className="text-[11.5px] text-muted-foreground">
                    Resolve the conflicts above before applying.
                  </small>
                )}
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
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
    <section className="space-y-3 rounded-xl border border-amber-300/70 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/25">
      <div>
        <h3 className="text-[13px] font-semibold tracking-tight">
          {detail.conflicts.length} file
          {detail.conflicts.length === 1 ? "" : "s"} need a decision
        </h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          These files were changed in more than one place. Choose which version
          to keep. Resolving builds a new candidate — it does not overwrite
          anything.
        </p>
      </div>

      {detail.conflicts.map((conflict) => (
        <fieldset
          key={conflict.path}
          className="space-y-2 rounded-lg border border-border bg-card p-3.5"
        >
          <legend className="px-1">
            <Path>{conflict.path}</Path>
          </legend>
          {conflict.sides.map((side) => (
            <label
              key={side.side}
              className={cn(
                "block cursor-pointer rounded-lg border p-3 transition-colors",
                choices[conflict.path] === side.side
                  ? "border-navy-300 bg-navy-50/70 dark:border-navy-700 dark:bg-navy-950/50"
                  : "border-border hover:bg-muted/50",
              )}
            >
              <span className="flex items-start gap-2.5">
                <Checkbox
                  type="radio"
                  className="mt-0.5 rounded-full"
                  name={`conflict:${conflict.path}`}
                  checked={choices[conflict.path] === side.side}
                  onChange={() =>
                    setChoices((current) => ({
                      ...current,
                      [conflict.path]: side.side,
                    }))
                  }
                />
                <span className="min-w-0 flex-1 text-[12.5px] font-medium">
                  {SIDE_LABEL[side.side] ?? side.side}
                  {side.text === null && (
                    <small className="font-normal text-muted-foreground">
                      {" "}
                      · this version deletes the file
                    </small>
                  )}
                </span>
              </span>
              {side.text !== null && (
                <pre className="mt-2.5 max-h-56 overflow-auto rounded-lg bg-muted/70 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                  {side.text}
                </pre>
              )}
            </label>
          ))}
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
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
        </Button>
        {!ready && (
          <small className="text-[11.5px] text-muted-foreground">
            Choose a version for every file above.
          </small>
        )}
      </div>
    </section>
  );
}

const CHANGE_TONE = {
  added: "done",
  modified: "info",
  deleted: "danger",
  renamed: "review",
} as const;

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
  }, [
    api,
    open,
    markdown,
    preview,
    workspaceId,
    reviewId,
    file.path,
    file.changeKind,
  ]);

  return (
    <details
      className="group overflow-hidden rounded-lg border border-border bg-card"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <Path className="min-w-0 border-0 bg-transparent px-0">
          {file.path}
        </Path>
        <Badge
          tone={
            CHANGE_TONE[file.changeKind as keyof typeof CHANGE_TONE] ??
            "neutral"
          }
          size="sm"
          className="ml-auto shrink-0"
        >
          {file.changeKind}
        </Badge>
      </summary>

      <div className="border-t border-border">
        <pre className="cf-diff max-h-96 overflow-auto p-3.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
          {file.diff}
        </pre>

        {markdown && file.changeKind !== "deleted" && (
          <div className="border-t border-border bg-muted/30 p-3.5">
            <h4 className="mb-2 text-[12px] font-semibold">
              How this file would read
            </h4>
            {failure ? (
              <ErrorText role="alert">{failure}</ErrorText>
            ) : preview ? (
              <pre className="max-h-72 overflow-auto rounded-lg bg-card p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                {preview.text}
              </pre>
            ) : (
              <p role="status" className="text-[12.5px] text-muted-foreground">
                Loading preview…
              </p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
