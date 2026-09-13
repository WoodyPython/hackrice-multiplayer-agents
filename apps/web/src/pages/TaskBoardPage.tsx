import { useCallback, useEffect, useState } from "react";
import { Plus, TriangleAlert } from "lucide-react";
import type { TaskSummary, Workspace } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { refreshLoop } from "../realtime";
import { apiMessage } from "../workspace-api";
import { EmptyState } from "../components/EmptyState";
import { PageHeading } from "../components/PageHeading";
import { Button, ButtonLink } from "../components/ui/button";
import { ErrorText, Skeleton } from "../components/ui/misc";
import { TaskBoard } from "./TaskBoard";

/**
 * The live board (design §4.3).
 *
 * Owners move settled tasks from task details; live runs update their own status.
 *
 * Refresh hints fetch authoritative state; polling repairs missed hints.
 */
export function TaskBoardPage({
  workspace,
}: {
  workspace: Workspace;
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
    let stopped = false;
    const pull = async () => {
      try {
        const next = await api.listTasks(workspace.id, controller.signal);
        if (controller.signal.aborted || stopped) return;
        setTasks(next);
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted && !stopped)
          setFailure(apiMessage(error));
      } finally {
        if (!controller.signal.aborted && !stopped) {
          setLoading(false);
        }
      }
    };
    const stopRefresh = refreshLoop(workspace.id, undefined, pull, () => 5000);
    return () => {
      stopped = true;
      controller.abort();
      stopRefresh();
    };
  }, [api, workspace.id, nonce]);

  const heading = (
    <PageHeading
      eyebrow="Your shared workspace"
      title={workspace.name}
      description={workspace.purpose || "A place to shape work together."}
      actions={
        <>
          <ButtonLink variant="primary" to={`${base}/tasks/new`}>
            <Plus aria-hidden="true" />
            Post a task
          </ButtonLink>
        </>
      }
    />
  );

  if (loading && tasks.length === 0)
    return (
      <>
        {heading}
        <p role="status" className="sr-only">
          Loading tasks…
        </p>
        <div
          aria-hidden="true"
          className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5"
        >
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="grid gap-2.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-28" />
              {index < 2 && <Skeleton className="h-28" />}
            </div>
          ))}
        </div>
      </>
    );

  if (failure && tasks.length === 0)
    return (
      <>
        {heading}
        <EmptyState
          title="Could not load tasks"
          icon={TriangleAlert}
          action={<Button onClick={reload}>Try again</Button>}
        >
          {failure}
        </EmptyState>
      </>
    );

  return (
    <>
      {failure && (
        <ErrorText role="alert" className="mb-4">
          {failure}
        </ErrorText>
      )}
      <TaskBoard
        tasks={tasks}
        base={base}
        heading={heading}
      />
    </>
  );
}
