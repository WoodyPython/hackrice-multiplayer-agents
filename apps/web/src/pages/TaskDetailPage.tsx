import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  isStartableTaskStatus,
  uuidSchema,
  type DraftFile,
  type Material,
  type TaskAttempt,
  type TaskDetail as Task,
  type TaskEvent,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { inputOptionsFrom, type TaskInputOption } from "../task-inputs";
import { Assignments } from "../components/Assignments";
import { Discussion, useDiscussion } from "../components/Discussion";
import { RunOutcome } from "../components/RunOutcome";
import { EmptyState } from "../components/EmptyState";
import { RequirementForm, type TaskFields } from "../components/RequirementForm";
import { TaskDetail, type TaskTab } from "./TaskDetail";

const ACTIVE = ["planning", "working", "needs_input"];
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
export function TaskDetailPage({ workspaceId }: { workspaceId: string }) {
  const { taskId } = useParams();
  const { api, session } = useBrowser();
  const [task, setTask] = useState<Task | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">(
    "loading",
  );
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const startId = useRef(crypto.randomUUID());
  // Read inside the polling loop, which must not restart every time the task
  // status changes — a restarting interval is how a poll ends up firing twice.
  const live = useRef(false);

  const valid = uuidSchema.safeParse(taskId).success;
  const reload = useCallback(() => setNonce((value) => value + 1), []);

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
        const [detail, mats, drafted, runs, log] = await Promise.all([
          api.readTask(workspaceId, taskId, controller.signal),
          api.listMaterials(workspaceId, controller.signal),
          api.listWorkspaceDrafts(workspaceId, controller.signal),
          api.listTaskAgents(workspaceId, taskId, controller.signal),
          api.listTaskEvents(workspaceId, taskId, undefined, controller.signal),
        ]);
        if (controller.signal.aborted || stopped) return;
        setTask(detail);
        setMaterials(mats);
        setDrafts(drafted);
        setAttempts(runs);
        // Read whole rather than from a cursor: the outcome panel needs the
        // LATEST start-phase reason, and a cursor-advanced read would hold only
        // whatever arrived since the last poll.
        setEvents(log.events);
        live.current = ACTIVE.includes(detail.status);
        setStatus("ready");
      } catch (error) {
        if (controller.signal.aborted || stopped) return;
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
  const options = inputOptionsFrom(materials, drafts);
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
    setBusy(true);
    setActionError(null);
    try {
      await run();
      reload();
      thread.refresh();
    } catch (error) {
      setActionError(apiMessage(error));
      // A version conflict means our copy is stale, not that the action was
      // wrong. Refetch so the next attempt carries the current version.
      if (error instanceof ApiError && error.code === "TASK_VERSION_CHANGED")
        reload();
    } finally {
      setBusy(false);
    }
  }

  async function save(fields: TaskFields) {
    if (!task || !taskId) return;
    await act(async () => {
      await api.updateTask(workspaceId, taskId, {
        expectedVersion: task.version,
        ...fields,
      });
      setEditing(false);
    });
  }

  const startable =
    task.kind === "agent_task" &&
    task.activeRunId === null &&
    isStartableTaskStatus(task.status);
  const running = ACTIVE.includes(task.status) && task.activeRunId !== null;
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
            void act(() =>
              api.retryTask(workspaceId, task.id, {
                expectedVersion: task.version,
                clientRequestId: crypto.randomUUID(),
              }),
            )
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
          <EmptyState title="Review is not connected yet">
            Combined changes, conflicts, and owner Apply arrive with the review
            handoff (C07) and owner apply (D07).
          </EmptyState>
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
          optionsNote="Approved files cannot be selected yet — nothing in the system can list them."
          guestLabel={session.getGuest().name}
          initial={{
            title: task.title,
            outcome: task.outcome,
            criteria: task.criteria,
            outputPaths: task.outputPaths,
            inputs: task.inputs.flatMap(
              (link): TaskInputOption["value"][] =>
                link.materialId
                  ? [{ materialId: link.materialId }]
                  : link.draftFileId
                    ? [{ draftFileId: link.draftFileId }]
                    : link.approvedPath
                      ? [{ approvedPath: link.approvedPath }]
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
            setEditing(false);
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
      banner={<RunOutcome events={events} status={task.status} />}
      action={action}
      renderTab={renderTab}
      onEditRequirements={
        task.status === "completed" ? undefined : () => setEditing(true)
      }
    />
  );
}
