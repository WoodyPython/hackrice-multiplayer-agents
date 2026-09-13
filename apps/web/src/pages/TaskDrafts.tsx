import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CircleAlert, GitCommitHorizontal, Plus } from "lucide-react";
import { ApiError, uuidSchema, type DraftFile } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "../components/EmptyState";
import { BackLink, PageHeading } from "../components/PageHeading";
import { Button } from "../components/ui/button";
import { Input, Label, Select } from "../components/ui/field";
import { ErrorText, Notice, Path, Skeleton } from "../components/ui/misc";

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
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
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
      <BackLink to={valid ? `${base}/tasks/${taskId}` : base}>
        Back to the task
      </BackLink>

      <PageHeading
        eyebrow="Shared editing"
        title="Shared drafts"
        description="Everyone with the workspace link edits this text together. Changes here are not approved until a review is applied."
      />

      {valid && (
        <form
          className="mb-5 flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 shadow-xs sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const opened = await api.openTaskDraft(
                workspaceId,
                taskId!,
                newPath.trim(),
              );
              setSelected(opened.id);
              setSaved(false);
              setClosed(false);
              setNewPath("");
              reload();
            });
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="task-draft-path">Draft file path</Label>
            <Input
              id="task-draft-path"
              placeholder="documents/notes.md"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              className="font-mono text-[12.5px]"
            />
          </div>
          <Button
            disabled={busy || !newPath.trim() || (!!draft && !saved)}
            type="submit"
          >
            <Plus aria-hidden="true" />
            Open task draft
          </Button>
        </form>
      )}

      {failure && !draft && <ErrorText role="alert">{failure}</ErrorText>}

      {status === "loading" ? (
        <>
          <p role="status" className="sr-only">
            Loading drafts…
          </p>
          <Skeleton aria-hidden="true" className="h-64" />
        </>
      ) : status !== "ready" ? (
        <EmptyState
          icon={CircleAlert}
          title={
            status === "missing" ? "Task not found" : "Could not load drafts"
          }
          action={<Button onClick={reload}>Try again</Button>}
        >
          Check the editing link or try again.
        </EmptyState>
      ) : !draft ? (
        <EmptyState title="No shared drafts yet">
          Open a text file above to edit it with collaborators on this task.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="draft-document">Document</Label>
              <div className="w-full sm:w-72">
                <Select
                  id="draft-document"
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
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
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
                <GitCommitHorizontal aria-hidden="true" />
                {busy ? "Working…" : "Checkpoint"}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !saved}
                onClick={() =>
                  void act(async () => {
                    await api.prepareReview(workspaceId, taskId!);
                    navigate(`${base}/tasks/${taskId}?tab=Changes`);
                  })
                }
              >
                {busy ? "Working…" : "Request review"}
              </Button>
            </div>
          </div>

          {closed && (
            <Notice role="alert" tone="warn" title="This document was closed">
              <p>
                Applying a review closes the version everyone was editing and
                opens a fresh one from the approved text. Your unsent words are
                still below — copy anything you want to keep, then open the
                current draft.
              </p>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setClosed(false);
                  setSaved(false);
                  reload();
                }}
              >
                Open the current draft
              </Button>
            </Notice>
          )}

          <p
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
            aria-live="polite"
          >
            {!saved && (
              <span className="font-medium text-amber-700 dark:text-amber-400">
                Unsaved — Checkpoint and Request review wait until the server
                has the text.
              </span>
            )}
            {checkpoint ? (
              <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                Checkpointed in Git at <Path>{checkpoint.slice(0, 8)}</Path>.
                Captured, not approved.
              </span>
            ) : (
              <span className="text-muted-foreground">
                Not checkpointed yet in this session.
              </span>
            )}
          </p>

          {failure && <ErrorText role="alert">{failure}</ErrorText>}

          <Suspense
            fallback={
              <p role="status" className="text-[13px] text-muted-foreground">
                Loading editor…
              </p>
            }
          >
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
              onClosed={() => setClosed(true)}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
