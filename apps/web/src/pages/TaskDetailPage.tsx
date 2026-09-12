import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError,
  isStartableTaskStatus,
  uuidSchema,
  type DraftFile,
  type Material,
  type TaskAttempt,
  type TaskDetail as Task,
  type SavedOutputOption,
  type TaskEvent,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { readEventPages } from "../task-polling";
import { apiMessage } from "../workspace-api";
import { inputOptionsFrom, type TaskInputOption } from "../task-inputs";
import { Assignments } from "../components/Assignments";
import { Changes } from "../components/Changes";
import { Discussion, useDiscussion } from "../components/Discussion";
import { RunOutcome } from "../components/RunOutcome";
import { SavedWork } from "../components/SavedWork";
import { EmptyState } from "../components/EmptyState";
import { RequirementForm, type TaskFields } from "../components/RequirementForm";
import { TaskDetail, tabs, type TaskTab } from "./TaskDetail";

const RETRYABLE = ["incomplete", "interrupted", "canceled"];

/**
 * Poll faster while an attempt is live.
 *
 * §5 makes durable events authoritative and realtime a latency optimisation
 * over polling, so the interval is a comfort setting rather than a correctness
 * one. Five seconds is fine for a posted task that changes when someone types;
 * it is too coarse while agents are running, where planning → working →
 * needs_input can all happen inside one tick and the screen looks stuck.
 */
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
}: {
  workspaceId: string;
  /**
   * Presentation only. The server checks the owner key on every apply, so this
   * decides what to render and never what is permitted (§4.6: "hiding a button
   * is insufficient").
   */
  isOwner: boolean;
}) {
  const { taskId } = useParams();
  return <TaskDetailState key={`${workspaceId}:${taskId?.toLowerCase()}`} workspaceId={workspaceId} taskId={taskId?.toLowerCase()} isOwner={isOwner} />;
}

function TaskDetailState({ workspaceId, taskId, isOwner }: { workspaceId: string; taskId: string | undefined; isOwner: boolean }) {
  const [params] = useSearchParams();
  const { api, session } = useBrowser();
  const [task, setTask] = useState<Task | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [approved, setApproved] = useState<import('@app/contracts').ApprovedFile[]>([]);
  const [inputError, setInputError] = useState<string>();
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">(
    "loading",
  );
  const [editing, setEditing] = useState<Task | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [savedOutputs, setSavedOutputs] = useState<SavedOutputOption[]>([]);
  const [keep, setKeep] = useState<string[]>([]);
  const startId = useRef(crypto.randomUUID());
  const retryId = useRef(crypto.randomUUID());
  const eventCache = useRef<TaskEvent[]>([]);
  const actionLock = useRef(false);
  const knownOutputs = useRef(new Set<string>());
  // Read inside the polling loop, which must not restart every time the task
  // status changes — a restarting interval is how a poll ends up firing twice.
  const live = useRef(false);

  const valid = uuidSchema.safeParse(taskId).success;
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void api.listApprovedFiles(workspaceId, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setApproved(result.files); setInputError(undefined); }
    }).catch(() => { if (!controller.signal.aborted) setInputError('Approved files could not be loaded. Reload to try again.'); });
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const pull = async () => {
      try {
        const [detail, mats, drafted, runs, log, saved] = await Promise.all([
          api.readTask(workspaceId, taskId, controller.signal),
          api.listMaterials(workspaceId, controller.signal),
          api.listWorkspaceDrafts(workspaceId, controller.signal),
          api.listTaskAgents(workspaceId, taskId, controller.signal),
          readEventPages(api, workspaceId, taskId, eventCache.current, controller.signal),
          api.listSavedOutputs(workspaceId, taskId, controller.signal),
        ]);
        if (controller.signal.aborted || stopped) return;
        setTask(detail);
        setMaterials(mats);
        setDrafts(drafted);
        setAttempts(runs);
        eventCache.current = log;
        setEvents(log);
        setSavedOutputs(saved);
        // Default to keeping everything that survived: §2.4's `incomplete`
        // state exists so saved work is reusable, and making someone re-tick
        // it every time invites discarding work by accident.
        const newOutputs = saved.map((output) => `${output.agentInstanceId}:${output.path}`)
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
      } finally {
        if (!controller.signal.aborted && !stopped)
          timer = setTimeout(
            () => void pull(),
            live.current ? POLL_ACTIVE_MS : POLL_IDLE_MS,
          );
      }
    };
    void pull();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, workspaceId, taskId, nonce, valid]);

  const thread = useDiscussion(workspaceId, valid ? taskId : undefined);
  const options = inputOptionsFrom(materials, drafts, approved);
  const base = `/w/${workspaceId}`;

  if (!valid || status === "missing")
    return (
      <EmptyState
        title="Task not found"
        action={
          <Link className="button" to={base}>
            Back to the board
          </Link>
        }
      >
        Check the link — this task is not in this workspace.
      </EmptyState>
    );
  if (status === "loading" && !task)
    return <p role="status">Opening task…</p>;
  if (!task)
    return (
      <EmptyState
        title="Could not load this task"
        action={<button onClick={reload}>Try again</button>}
      >
        Check your connection and try again.
      </EmptyState>
    );

  async function act(run: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true;
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
      await api.updateTask(workspaceId, taskId, {
        expectedVersion: editing.version,
        ...fields,
      });
      setEditing(null);
    });
  }

  const startable =
    task.kind === "agent_task" &&
    task.activeRunId === null &&
    isStartableTaskStatus(task.status);
  const running = task.activeRunId !== null;
  const retryable = RETRYABLE.includes(task.status) && task.activeRunId === null;

  const action = (
    <div className="start-action">
      {startable && (
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api.startTask(workspaceId, task.id, {
                expectedVersion: task.version,
                clientRequestId: startId.current,
              });
              // Rotate only on success. A failed Start keeps its key so a
              // retry REPLAYS that intent; a Start after a cancel is a new
              // intent and must not replay the canceled run, which is what
              // holding one key for the component's lifetime would do.
              startId.current = crypto.randomUUID();
            })
          }
        >
          {busy ? "Starting…" : "Start task"}
        </button>
      )}
      {running && (
        <button
          disabled={busy}
          onClick={() =>
            void act(() =>
              api.cancelTask(workspaceId, task.id, crypto.randomUUID()),
            )
          }
        >
          {busy ? "Stopping…" : "Stop this attempt"}
        </button>
      )}
      {retryable && (
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api.retryTask(workspaceId, task.id, {
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
              retryId.current = crypto.randomUUID();
            })
          }
        >
          {busy ? "Retrying…" : "Retry from saved work"}
        </button>
      )}
      {startable && (
        <small>Starting freezes the requirements and discussion as context.</small>
      )}
      {actionError && (
        <small role="alert" className="error">
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
          <p role="status">Loading discussion…</p>
        ) : (
          <>
            {thread.failure && (
              <p role="alert" className="error">
                {thread.failure}
              </p>
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
            />
          </>
        );
      case "Drafts": {
        const mine = drafts.filter((draft) => draft.taskId === task.id);
        return mine.length === 0 ? (
          <EmptyState title="No shared drafts yet">
            This task has no open documents. Open one from Files with Edit
            together, and it will appear here.
          </EmptyState>
        ) : (
          <>
            <ul className="file-list">
              {mine.map((draft) => (
                <li key={draft.id}>▤ {draft.path}</li>
              ))}
            </ul>
            <Link className="button primary" to={`${base}/tasks/${task.id}/drafts`}>
              Open the shared editor
            </Link>
          </>
        );
      }
      case "Agents":
        return <Assignments attempts={attempts} />;
      case "Changes":
        return (
          <Changes
            task={task}
            isOwner={isOwner}
            staleSignal={
              // §7.6: continued typing invalidates a review. The event record
              // is already polled here, so the Changes tab learns it without a
              // second loop of its own.
              [...events]
                .reverse()
                .find((event) => event.type === "review.stale")?.id
            }
            onApplied={() => {
              reload();
              thread.refresh();
            }}
          />
        );
    }
  }

  if (editing)
    return (
      <>
        <Link className="back-link" to={`${base}/tasks/${task.id}`}>
          ← Back to the task
        </Link>
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
                  ? [{ materialId: link.materialId, ...(link.sourceVersion !== null ? { sourceVersion: link.sourceVersion } : {}) }]
                  : link.draftFileId
                    ? [{ draftFileId: link.draftFileId, ...(link.sourceVersion !== null ? { sourceVersion: link.sourceVersion } : {}) }]
                    : link.approvedPath
                      ? [{ approvedPath: link.approvedPath, ...(link.sourceVersion !== null ? { sourceVersion: link.sourceVersion } : {}) }]
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
              "Saving raises the task version. Any result from an older version has to be reviewed against these requirements before it can be applied.",
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
      options={options}
      banner={
        <>
          {pollError && <p role="alert">{pollError}</p>}
          <RunOutcome
            events={events}
            status={task.status}
            runId={task.activeRunId ?? [...attempts].sort((a, b) => b.attempt - a.attempt)[0]?.runId}
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
      renderTab={renderTab}
      initialTab={
        // Only a tab name we actually have; a hand-edited query must not
        // produce a panel with nothing in it.
        (tabs as readonly string[]).includes(params.get("tab") ?? "")
          ? (params.get("tab") as TaskTab)
          : undefined
      }
      onEditRequirements={
        task.status === "completed" ? undefined : () => setEditing(task)
      }
    />
  );
}
