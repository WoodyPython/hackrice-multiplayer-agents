import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CircleAlert, FileText, Paperclip, Play, RotateCcw, Square, Upload } from "lucide-react";
import {
  ApiError,
  MAX_TEXT_FILE_BYTES,
  SUPPORTED_TEXT_EXTENSIONS,
  isStartableTaskStatus,
  uuidSchema,
  type DraftFile,
  type Material,
  type TaskAttempt,
  type TaskDetail as Task,
  type SavedOutputOption,
  type TaskEvent,
  type Participant,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { refreshLoop } from "../realtime";
import { readEventPages } from "../task-polling";
import { apiMessage } from "../workspace-api";
import { inputOptionsFrom, type TaskInputOption } from "../task-inputs";
import { Assignments } from "../components/Assignments";
import { Changes } from "../components/Changes";
import { Discussion, useDiscussion } from "../components/Discussion";
import { ReviewReady } from "../components/ReviewReady";
import { RunOutcome } from "../components/RunOutcome";
import { SavedWork } from "../components/SavedWork";
import { EmptyState } from "../components/EmptyState";
import {
  RequirementForm,
  type TaskFields,
} from "../components/RequirementForm";
import { BackLink } from "../components/PageHeading";
import { Button, ButtonLink } from "../components/ui/button";
import { ErrorText, Skeleton } from "../components/ui/misc";
import { TaskDetail, tabs, type TaskTab } from "./TaskDetail";

const RETRYABLE = ["incomplete", "interrupted", "canceled"];

// Push handles normal updates; polling repairs missed hints and older servers.
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 5000;

/**
 * The live task screen (design §2.1–2.4, §4.2).
 *
 * Every state-changing action here carries a `clientRequestId` that is created
 * once per user intent and reused on retry, so a double-tap or a retried
 * request resolves to the original run or entry rather than creating a second.
 * §2.2 is explicit that this is one of two independent duplicate-Start guards;
 * the other is the server's unique active-run index, which we cannot see from
 * here and must not assume is doing the work alone.
 */
export function TaskDetailPage({
  workspaceId,
  isOwner,
  participants,
  presenceId,
}: {
  workspaceId: string;
  /**
   * Presentation only, and no longer used for Apply.
   *
   * Apply is open to every contributor now, so this gates only the owner's
   * task-status controls. The server checks the owner key on those the same
   * way -- hiding a control is never the enforcement (section 4.6).
   */
  isOwner: boolean;
  participants: Participant[];
  presenceId: string;
}) {
  const { taskId } = useParams();
  return (
    <TaskDetailState
      key={`${workspaceId}:${taskId?.toLowerCase()}`}
      workspaceId={workspaceId}
      taskId={taskId?.toLowerCase()}
      isOwner={isOwner}
      participants={participants}
      presenceId={presenceId}
    />
  );
}

function TaskDetailState({
  workspaceId,
  taskId,
  isOwner,
  participants,
  presenceId,
}: {
  workspaceId: string;
  taskId: string | undefined;
  isOwner: boolean;
  participants: Participant[];
  presenceId: string;
}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { api, session } = useBrowser();
  const [task, setTask] = useState<Task | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [taskMaterials, setTaskMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [approved, setApproved] = useState<
    import("@app/contracts").ApprovedFile[]
  >([]);
  const [inputError, setInputError] = useState<string>();
  const [status, setStatus] = useState<
    "loading" | "ready" | "missing" | "error"
  >("loading");
  const [editing, setEditing] = useState<Task | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [savedOutputs, setSavedOutputs] = useState<SavedOutputOption[]>([]);
  const [keep, setKeep] = useState<string[]>([]);
  const startId = useRef(crypto.randomUUID());
  const retryId = useRef(crypto.randomUUID());
  const eventCache = useRef<TaskEvent[]>([]);
  const actionLock = useRef(false);
  const readEpoch = useRef(0);
  const knownOutputs = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  // Read inside the polling loop, which must not restart every time the task
  // status changes — a restarting interval is how a poll ends up firing twice.
  const live = useRef(false);

  const valid = uuidSchema.safeParse(taskId).success;
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .listApprovedFiles(workspaceId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setApproved(result.files);
          setInputError(undefined);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setInputError(
            "Approved files could not be loaded. Reload to try again.",
          );
      });
    return () => controller.abort();
  }, [api, workspaceId, nonce]);

  // Task detail is refetched whole rather than patched: status is derived
  // server-side from run and question records, so the authoritative answer to
  // "what state is this in" only ever comes from a read.
  useEffect(() => {
    if (!valid || !taskId) {
      setStatus("missing");
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    const pull = async () => {
      const epoch = readEpoch.current;
      try {
        const [detail, mats, attached, drafted, runs, log, saved] = await Promise.all([
          api.readTask(workspaceId, taskId, controller.signal),
          api.listMaterials(workspaceId, controller.signal),
          api.listTaskMaterials(workspaceId, taskId, controller.signal),
          api.listWorkspaceDrafts(workspaceId, controller.signal),
          api.listTaskAgents(workspaceId, taskId, controller.signal),
          readEventPages(
            api,
            workspaceId,
            taskId,
            eventCache.current,
            controller.signal,
          ),
          api.listSavedOutputs(workspaceId, taskId, controller.signal),
        ]);
        if (controller.signal.aborted || stopped || epoch !== readEpoch.current) return;
        setTask(detail);
        setMaterials(mats);
        setTaskMaterials(attached);
        setDrafts(drafted);
        setAttempts(runs);
        eventCache.current = log;
        setEvents(log);
        setSavedOutputs(saved);
        // Default to keeping everything that survived: §2.4's `incomplete`
        // state exists so saved work is reusable, and making someone re-tick
        // it every time invites discarding work by accident.
        const newOutputs = saved
          .map((output) => `${output.agentInstanceId}:${output.path}`)
          .filter((key) => !knownOutputs.current.has(key));
        newOutputs.forEach((key) => knownOutputs.current.add(key));
        setKeep((current) => [...current, ...newOutputs]);
        live.current = detail.activeRunId !== null;
        setStatus("ready");
        setPollError(null);
      } catch (error) {
        if (controller.signal.aborted || stopped) return;
        setPollError(apiMessage(error));
        setStatus(
          error instanceof ApiError && error.code === "TASK_NOT_FOUND"
            ? "missing"
            : "error",
        );
      }
    };
    const stopRefresh = refreshLoop(workspaceId, taskId, pull,
      () => live.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => {
      stopped = true;
      controller.abort();
      stopRefresh();
    };
  }, [api, workspaceId, taskId, nonce, valid]);

  const thread = useDiscussion(workspaceId, valid ? taskId : undefined);
  const options = inputOptionsFrom(materials, drafts, approved);
  const base = `/w/${workspaceId}`;

  if (!valid || status === "missing")
    return (
      <EmptyState
        title="Task not found"
        icon={CircleAlert}
        action={
          <ButtonLink variant="primary" to={base}>
            Back to the board
          </ButtonLink>
        }
      >
        Check the link — this task is not in this workspace.
      </EmptyState>
    );
  if (status === "loading" && !task)
    return (
      <>
        <p role="status" className="sr-only">
          Opening task…
        </p>
        <div aria-hidden="true" className="space-y-5">
          <Skeleton className="h-9 w-2/3" />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <Skeleton className="h-72" />
            <Skeleton className="h-72" />
          </div>
        </div>
      </>
    );
  if (!task)
    return (
      <EmptyState
        title="Could not load this task"
        icon={CircleAlert}
        action={<Button onClick={reload}>Try again</Button>}
      >
        Check your connection and try again.
      </EmptyState>
    );

  async function act(run: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true;
    // Ignore reads that started before this mutation. Their payload is valid
    // for an older server state and must not overwrite the mutation response.
    readEpoch.current += 1;
    setBusy(true);
    setActionError(null);
    try {
      await run();
      reload();
      thread.refresh();
    } catch (error) {
      setActionError(apiMessage(error));
      // Refresh task actions after a conflict. An open edit keeps its original
      // version until the contributor closes and reopens the form.
      if (error instanceof ApiError && error.code === "TASK_VERSION_CHANGED")
        reload();
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  async function save(fields: TaskFields) {
    if (!editing || !taskId) return;
    await act(async () => {
      const updated = await api.updateTask(workspaceId, taskId, {
        expectedVersion: editing.version,
        ...fields,
      });
      setTask(updated);
      setEditing(null);
    });
  }

  // §7.6: continued typing invalidates a review. The event record is already
  // polled here, so both the banner and the Changes tab learn about it without
  // a second loop of their own.
  const staleSignal = [...events]
    .reverse()
    .find((event) => event.type === "review.stale")?.id;

  async function attachFile(file: File) {
    if (!taskId || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { material } = await api.uploadMaterial(
        workspaceId,
        file,
        session.getGuest().name,
        { taskId },
      );
      setMaterials((current) =>
        current.some((item) => item.id === material.id) ? current : [...current, material],
      );
      setTaskMaterials((current) =>
        current.some((item) => item.id === material.id) ? current : [...current, material],
      );
      reload();
    } catch (error) {
      setUploadError(apiMessage(error));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const startable =
    task.kind === "agent_task" &&
    task.activeRunId === null &&
    isStartableTaskStatus(task.status);
  const running = task.activeRunId !== null;
  const retryable =
    RETRYABLE.includes(task.status) && task.activeRunId === null;

  const action = (
    <div className="flex max-w-xs flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap justify-end gap-2">
        {!running && (
          <Button variant={task.status === "completed" ? "outline" : "secondary"} disabled={busy}
            onClick={() => void act(async () => setTask(await api.moveTask(workspaceId, task.id, task.status,
              task.status === "completed" ? "unmark" : "completed")))}>
            {task.status === "completed" ? "Unmark as Complete" : "Mark as Complete"}
          </Button>
        )}
        {isOwner && !running && task.status !== "posted" && (
          <select aria-label="Move task" value="" disabled={busy}
            className="h-9 max-w-full rounded-lg border border-border bg-card px-3 text-[12px]"
            onChange={(event) => { if (event.target.value) { const target = event.target.value as "posted" | "ready_for_review";
              void act(async () => setTask(await api.moveTask(workspaceId, task.id, task.status, target))); } }}>
            <option value="" disabled>Move to...</option>
            <option value="posted">Posted</option>
            {(task.status === "completed" || task.status === "awaiting_confirmation") && <option value="ready_for_review">In review</option>}
          </select>
        )}
        {startable && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const started = await api.startTask(workspaceId, task.id, {
                  expectedVersion: task.version,
                  clientRequestId: startId.current,
                });
                setTask((current) => current && ({ ...current, status: started.taskStatus, activeRunId: started.runId }));
                // Rotate only on success. A failed Start keeps its key so a
                // retry REPLAYS that intent; a Start after a cancel is a new
                // intent and must not replay the canceled run, which is what
                // holding one key for the component's lifetime would do.
                startId.current = crypto.randomUUID();
              })
            }
          >
            <Play aria-hidden="true" />
            {busy ? "Starting…" : task.status === "posted" ? "Start task" : "Run again"}
          </Button>
        )}
        {running && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => setTask(await api.cancelTask(workspaceId, task.id, crypto.randomUUID())))
            }
          >
            <Square aria-hidden="true" />
            {busy ? "Stopping…" : "Stop this attempt"}
          </Button>
        )}
        {retryable && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const started = await api.retryTask(workspaceId, task.id, {
                  expectedVersion: task.version,
                  clientRequestId: retryId.current,
                  savedOutputs: savedOutputs
                    .filter((output) =>
                      keep.includes(`${output.agentInstanceId}:${output.path}`),
                    )
                    // Identities only. The server resolves the commit under the
                    // task lock; a client-supplied SHA is never accepted.
                    .map((output) => ({
                      agentInstanceId: output.agentInstanceId,
                      path: output.path,
                    })),
                });
                setTask((current) => current && ({ ...current, status: started.taskStatus, activeRunId: started.runId }));
                retryId.current = crypto.randomUUID();
              })
            }
          >
            <RotateCcw aria-hidden="true" />
            {busy ? "Retrying…" : "Retry from saved work"}
          </Button>
        )}
      </div>
      {actionError && (
        <small
          role="alert"
          className="text-[11.5px] text-destructive sm:text-right"
        >
          {actionError}
        </small>
      )}
    </div>
  );

  function renderTab(tab: TaskTab) {
    if (!task || !taskId) return null;
    switch (tab) {
      case "Discussion":
        return thread.loading ? (
          <>
            <p role="status" className="sr-only">
              Loading discussion…
            </p>
            <Skeleton aria-hidden="true" className="h-40" />
          </>
        ) : (
          <>
            {thread.failure && (
              <ErrorText role="alert" className="mb-3">
                {thread.failure}
              </ErrorText>
            )}
            <Discussion
              workspaceId={workspaceId}
              taskId={taskId}
              entries={thread.entries}
              latestSeq={thread.latestSeq}
              activeRunCutoffSeq={thread.activeRunCutoffSeq}
              materials={materials}
              onChanged={thread.refresh}
              busy={busy}
              participants={participants}
              presenceId={presenceId}
            />
          </>
        );
      case "Drafts": {
        const mine = drafts.filter((draft) => draft.taskId === task.id);
        return mine.length === 0 ? (
          <EmptyState title="No shared drafts yet" icon={FileText}>
            This task has no open documents. Open one from Files with Edit
            together, and it will appear here.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            <ul className="grid gap-2">
              {mine.map((draft) => (
                <li
                  key={draft.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
                >
                  <FileText
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate font-mono text-[12px]">
                    {draft.path}
                  </span>
                </li>
              ))}
            </ul>
            <ButtonLink
              variant="primary"
              to={`${base}/tasks/${task.id}/drafts`}
            >
              Open the shared editor
            </ButtonLink>
          </div>
        );
      }
      case "Agents":
        return <Assignments attempts={attempts} />;
      case "Changes":
        return (
          <Changes
            task={task}
            staleSignal={staleSignal}
            onApplied={() => {
              setTask((current) => current && ({
                ...current,
                status: current.kind === "manual_edit" ? "completed" : "awaiting_confirmation",
                activeRunId: null,
              }));
              reload();
              thread.refresh();
              if (task.kind === "manual_edit") {
                navigate(`${base}/files`, { replace: true });
              }
            }}
          />
        );
    }
  }

  if (editing)
    return (
      <>
        <BackLink to={`${base}/tasks/${task.id}`}>Back to the task</BackLink>
        <RequirementForm
          options={options}
          optionsNote={inputError}
          guestLabel={session.getGuest().name}
          initial={{
            title: editing.title,
            outcome: editing.outcome,
            criteria: editing.criteria,
            outputPaths: editing.outputPaths,
            inputs: editing.inputs.flatMap(
              (link): TaskInputOption["value"][] =>
                link.materialId
                  ? [
                      {
                        materialId: link.materialId,
                        ...(link.sourceVersion !== null
                          ? { sourceVersion: link.sourceVersion }
                          : {}),
                      },
                    ]
                  : link.draftFileId
                    ? [
                        {
                          draftFileId: link.draftFileId,
                          ...(link.sourceVersion !== null
                            ? { sourceVersion: link.sourceVersion }
                            : {}),
                        },
                      ]
                    : link.approvedPath
                      ? [
                          {
                            approvedPath: link.approvedPath,
                            ...(link.sourceVersion !== null
                              ? { sourceVersion: link.sourceVersion }
                              : {}),
                          },
                        ]
                      : [],
            ),
          }}
          pending={busy}
          error={actionError}
          submitLabel="Save requirements"
          heading={{
            eyebrow: "Revise the brief",
            title: "Change what this task is asking for.",
            blurb:
              "Saving updates the brief. Existing work is checked against the new request before it can be applied.",
          }}
          onSubmit={(fields) => void save(fields)}
          onCancel={() => {
            setEditing(null);
            setActionError(null);
          }}
        />
      </>
    );

  return (
    <TaskDetail
      task={task}
      base={base}
      backTo={params.get("from") === "history" ? `${base}/history`
        : params.get("from") === "agent-history" ? `${base}/history?view=agents`
        : params.get("from") === "agents" ? `${base}/agents` : undefined}
      backLabel={params.get("from") === "agents" ? "Back to agents" : undefined}
      options={options}
      banner={
        <>
          {pollError && <ErrorText role="alert">{pollError}</ErrorText>}
          <ReviewReady
            task={task}
            staleSignal={staleSignal}
            onOpenReview={() => {
              // Through the URL rather than component state, so the opened
              // review is linkable and the back button behaves.
              const next = new URLSearchParams(params);
              next.set("tab", "Changes");
              setParams(next, { replace: true });
            }}
          />
          <RunOutcome
            events={events}
            status={task.status}
            runId={
              task.activeRunId ??
              [...attempts].sort((a, b) => b.attempt - a.attempt)[0]?.runId
            }
          />
          {retryable && savedOutputs.length > 0 && (
            <SavedWork
              outputs={savedOutputs}
              keep={keep}
              onToggle={(key) =>
                setKeep((current) =>
                  current.includes(key)
                    ? current.filter((value) => value !== key)
                    : [...current, key],
                )
              }
            />
          )}
        </>
      }
      action={action}
      taskFiles={
        <section className="mt-6 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
              Task files
            </h3>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11.5px] font-medium hover:bg-muted">
              <Upload aria-hidden="true" className="size-3" />
              {uploading ? "Adding…" : "Add file"}
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                accept={SUPPORTED_TEXT_EXTENSIONS.join(",")}
                disabled={uploading || busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void attachFile(file);
                }}
              />
            </label>
          </div>
          {taskMaterials.length > 0 ? (
            <ul className="space-y-1.5">
              {taskMaterials.map((material) => (
                <li key={material.id} className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-[12px]">
                  <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{material.filename}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-muted-foreground">Add text, Markdown, or code for this task to use.</p>
          )}
          <small className="block text-[10.5px] text-muted-foreground">
            Up to {Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB. Added files become task context.
          </small>
          {uploadError && <ErrorText role="alert">{uploadError}</ErrorText>}
        </section>
      }
      renderTab={renderTab}
      attention={task.status === "ready_for_review" ? ["Changes"] : undefined}
      initialTab={
        // Only a tab name we actually have; a hand-edited query must not
        // produce a panel with nothing in it.
        (tabs as readonly string[]).includes(params.get("tab") ?? "")
          ? (params.get("tab") as TaskTab)
          : undefined
      }
      onTabChange={(tab) => {
        const next = new URLSearchParams(params);
        next.set("tab", tab);
        setParams(next, { replace: true });
      }}
      onEditRequirements={
        ["completed", "awaiting_confirmation"].includes(task.status) ? undefined : () => setEditing(task)
      }
    />
  );
}
