import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { TaskSummary, Workspace } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "../components/EmptyState";
import { TaskBoard } from "./TaskBoard";

/**
 * The live board (design §4.3).
 *
 * Placement is state-derived and nothing here can move a card: §4.3 is explicit
 * that "dragging a card cannot mark work approved", so there is no drag
 * affordance at all rather than one that is refused on drop.
 *
 * Polled rather than pushed. §5 makes durable events authoritative and realtime
 * a latency optimisation over exactly this, so the board is correct with the
 * subscription absent — which it currently is, since nobody has verified a hint
 * arriving in a browser.
 */
export function TaskBoardPage({
  workspace,
  share,
}: {
  workspace: Workspace;
  share: ReactNode;
}) {
  const { api } = useBrowser();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const base = `/w/${workspace.id}`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const pull = async () => {
      try {
        const next = await api.listTasks(workspace.id, controller.signal);
        if (controller.signal.aborted || stopped) return;
        setTasks(next);
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted && !stopped) setFailure(apiMessage(error));
      } finally {
        if (!controller.signal.aborted && !stopped) {
          setLoading(false);
          timer = setTimeout(() => void pull(), 5000);
        }
      }
    };
    void pull();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, workspace.id, nonce]);

  const heading = (
    <header className="page-heading">
      <div>
        <span className="eyebrow">Your shared workspace</span>
        <h1>{workspace.name}</h1>
        <p>{workspace.purpose || "A place to shape work together."}</p>
      </div>
      <div className="heading-actions">
        <Link className="button primary" to={`${base}/tasks/new`}>
          ＋ Post a task
        </Link>
        {share}
      </div>
    </header>
  );

  if (loading && tasks.length === 0)
    return (
      <>
        {heading}
        <p role="status">Loading tasks…</p>
      </>
    );

  if (failure && tasks.length === 0)
    return (
      <>
        {heading}
        <EmptyState
          title="Could not load tasks"
          action={<button onClick={reload}>Try again</button>}
        >
          {failure}
        </EmptyState>
      </>
    );

  return (
    <>
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}
      <TaskBoard tasks={tasks} base={base} heading={heading} />
    </>
  );
}
