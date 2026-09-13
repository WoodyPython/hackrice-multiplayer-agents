import { useEffect, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ArrowRight, CircleAlert, FlaskConical } from "lucide-react";
import { isStartableTaskStatus, type TaskDetail as Task } from "@app/contracts";
import {
  createFixtureTask,
  initialTasks,
  summarize,
  workspace,
} from "./fixtures";
import { AppShell, type NavItem } from "./components/AppShell";
import { EmptyState } from "./components/EmptyState";
import { Wordmark } from "./components/Logo";
import { BackLink, PageHeading } from "./components/PageHeading";
import { RequirementForm } from "./components/RequirementForm";
import { ThemeToggle } from "./components/ThemeToggle";
import { Badge, Dot } from "./components/ui/badge";
import { Button, ButtonLink } from "./components/ui/button";
import { Select } from "./components/ui/field";
import { Eyebrow, Skeleton } from "./components/ui/misc";
import { TaskBoard } from "./pages/TaskBoard";
import { TaskDetail, type TaskTab } from "./pages/TaskDetail";
import { inputOptions } from "./fixtures";

/**
 * The demo renders the same task screen the live app does, with fixture data.
 * Its tabs are inert by design — this route exists to show the shell without a
 * backend, so it must not imply that discussion or agents are connected.
 */
const demoTabCopy: Record<TaskTab, readonly [string, string]> = {
  Discussion: [
    "Start with a conversation",
    "Discussion is live in a real workspace. This preview does not post anything.",
  ],
  Drafts: [
    "A place for work in progress",
    "Shared drafts open from Files in a real workspace.",
  ],
  Agents: [
    "Assignments will appear here",
    "Agent progress is not connected in this preview. Posting a task does not start any agents.",
  ],
  Changes: [
    "Nothing to review here yet",
    "Combined changes and owner review appear once a review exists.",
  ],
};
import { useGuest } from "./browser-context";
import { GuestNameControl } from "./components/GuestNameControl";

function TaskRoute({ tasks, base, onToggleComplete }: { tasks: Task[]; base: string; onToggleComplete: (task: Task) => void }) {
  const { taskId } = useParams();
  const task = tasks.find((item) => item.id === taskId);
  return task ? (
    <TaskDetail
      key={task.id}
      task={task}
      base={base}
      options={inputOptions}
      action={<div className="flex max-w-xs flex-col items-end gap-2">
        {task.activeRunId === null && <Button onClick={() => onToggleComplete(task)}>
          {task.status === "completed" ? "Unmark as Complete" : "Mark as Complete"}
        </Button>}
        {task.kind === "agent_task" &&
        task.activeRunId === null &&
        isStartableTaskStatus(task.status) ? (
          <div className="flex max-w-xs flex-col items-stretch gap-2 sm:items-end">
            {/* Inert here on purpose: this route has no backend to start. */}
            <Button variant="primary" disabled aria-describedby="start-help">
              Start task
            </Button>
            <small
              id="start-help"
              className="text-[11px] text-muted-foreground sm:text-right"
            >
              Execution is not connected in this preview.
            </small>
          </div>
        ) : undefined}
      </div>}
      renderTab={(tab) => (
        <EmptyState title={demoTabCopy[tab][0]}>
          {demoTabCopy[tab][1]}
        </EmptyState>
      )}
    />
  ) : (
    <EmptyState
      title="Task not found"
      icon={CircleAlert}
      action={
        <ButtonLink variant="primary" to={base}>
          Back to tasks
        </ButtonLink>
      }
    >
      This task isn't available in this workspace. Check the link or return to
      the board.
    </EmptyState>
  );
}

function WorkspaceShell() {
  const guest = useGuest();
  const { workspaceId } = useParams();
  const [tasks, setTasks] = useState(initialTasks);
  const [previousStatuses, setPreviousStatuses] = useState<Record<string, Task['status']>>({});
  const toggleComplete = (task: Task) => {
    if (task.status !== "completed") setPreviousStatuses((old) => ({ ...old, [task.id]: task.status }));
    setTasks((old) => old.map((item) => item.id === task.id ? { ...item,
      status: item.status === "completed" ? previousStatuses[item.id] ?? "ready_for_review" : "completed",
    } : item));
  };
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const base = `/demo/w/${workspace.id}`;
  const view = search.get("view") ?? "sample";
  const items: NavItem[] = [
    { to: base, label: "Tasks", icon: "board", end: true, count: tasks.length },
    { to: `${base}/files`, label: "Files", icon: "files" },
    { to: `${base}/history`, label: "History", icon: "history" },
  ];
  useEffect(() => {
    document.title = `${workspace.name} — CoFlow`;
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location.pathname]);
  if (workspaceId !== workspace.id)
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20">
        <EmptyState
          title="Workspace not found"
          icon={CircleAlert}
          action={
            <ButtonLink variant="primary" to="/">
              Back home
            </ButtonLink>
          }
        >
          Check the workspace link or open the sample workspace.
        </EmptyState>
      </main>
    );
  return (
    <AppShell
      workspaceName={workspace.name}
      workspaceSubtitle="Sample workspace"
      settingsTo={`${base}/settings`}
      items={items}
      guestName={guest.name}
      guestRole="Guest contributor"
      profileControl={<GuestNameControl sidebar />}
      topbarEnd={
        <div className="flex items-center gap-2.5">
          <Badge tone="info" className="hidden sm:inline-flex">
            <Dot tone="info" live />
            Sample workspace
          </Badge>
        </div>
      }
      strip={
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2 sm:px-6 lg:px-8">
          <span className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <FlaskConical aria-hidden="true" className="size-3.5" />
            Interactive preview · Changes last until you reload.
          </span>
          <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            Preview state
            <span className="w-36">
              <Select
                aria-label="Preview state"
                value={view}
                className="h-8 text-[11.5px]"
                onChange={(event) =>
                  setSearch(
                    event.target.value === "sample"
                      ? {}
                      : { view: event.target.value },
                  )
                }
              >
                <option value="sample">Sample data</option>
                <option value="empty">Empty</option>
                <option value="loading">Loading</option>
                <option value="error">Load error</option>
              </Select>
            </span>
          </label>
        </div>
      }
    >
      {view === "loading" ? (
        <section aria-busy="true" aria-label="Loading workspace">
          <p role="status" className="sr-only">
            Loading workspace…
          </p>
          <div aria-hidden="true" className="space-y-6">
            <Skeleton className="h-10 w-1/2" />
            <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton className="h-40" key={index} />
              ))}
            </div>
          </div>
        </section>
      ) : view === "error" ? (
        <EmptyState
          title="We couldn't load this workspace"
          icon={CircleAlert}
          action={<Button onClick={() => setSearch({})}>Try again</Button>}
        >
          Your work hasn't been changed. Retry loading the workspace to
          continue.
        </EmptyState>
      ) : (
        <Routes>
          <Route
            index
            element={
              <TaskBoard
                tasks={view === "empty" ? [] : tasks.map(summarize)}
                base={base}
              />
            }
          />
          <Route
            path="tasks/new"
            element={
              <>
                <BackLink to={base}>All tasks</BackLink>
                <PageHeading
                  eyebrow="From an idea to a shared task"
                  title="What shall we work on?"
                  description="Post the brief first. Decide when to start together."
                />
                <RequirementForm
                  guestLabel={guest.name}
                  options={inputOptions}
                  onCancel={() => navigate(base)}
                  onSubmit={(fields) => {
                    const task = createFixtureTask({
                      kind: "agent_task",
                      ...fields,
                      creatorGuestLabel: guest.name,
                    });
                    setTasks((previous) => [task, ...previous]);
                    navigate(`${base}/tasks/${task.id}`);
                  }}
                />
              </>
            }
          />
          <Route
            path="tasks/:taskId"
            element={<TaskRoute tasks={tasks} base={base} onToggleComplete={toggleComplete} />}
          />
          <Route
            path="files"
            element={
              <>
                <PageHeading
                  eyebrow="The shared library"
                  title="Files"
                  description="Approved work, source material, and drafts in one place."
                />
                <div className="grid gap-4 lg:grid-cols-3">
                  {[
                    "Approved files",
                    "Reference materials",
                    "Active shared drafts",
                  ].map((title) => (
                    <EmptyState key={title} title={title}>
                      File browsing and editing will connect in a later ticket.
                    </EmptyState>
                  ))}
                </div>
              </>
            }
          />
          <Route
            path="history"
            element={
              <>
                <PageHeading eyebrow="A record of progress" title="History" />
                <EmptyState title="The story starts with your first change">
                  Applied changes and their associated tasks will appear here
                  when history is connected.
                </EmptyState>
              </>
            }
          />
          <Route
            path="settings"
            element={
              <>
                <PageHeading
                  eyebrow="Workspace settings"
                  title={workspace.name}
                  description={workspace.purpose}
                />
                <section className="max-w-2xl space-y-3 rounded-xl border border-border bg-card p-6 shadow-xs">
                  <h2 className="text-[17px] font-semibold tracking-tight">
                    Workspace details
                  </h2>
                  <h3 className="text-[12px] font-medium text-muted-foreground">Description</h3>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {workspace.guidance || workspace.purpose}
                  </p>
                </section>
              </>
            }
          />
          <Route
            path="*"
            element={
              <EmptyState
                title="Page not found"
                action={
                  <ButtonLink variant="primary" to={base}>
                    Back to tasks
                  </ButtonLink>
                }
              >
                This page isn't available in the workspace preview.
              </EmptyState>
            }
          />
        </Routes>
      )}
    </AppShell>
  );
}

export function DemoApp() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16">
            <div className="mb-14 flex items-center justify-between">
              <Link to="/" aria-label="CoFlow home" className="rounded-lg">
                <Wordmark size="lg" />
              </Link>
              <ThemeToggle />
            </div>
            <Eyebrow>A little more possible, together</Eyebrow>
            <h1 className="mt-4 text-[46px] leading-[1.05] font-semibold tracking-[-0.04em] sm:text-[60px]">
              Make room
              <br />
              <span className="text-navy-700 dark:text-navy-300">
                for good work.
              </span>
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted-foreground">
              A shared place for your team's ideas, drafts, and the agents that
              help bring them to life.
            </p>
            <div className="mt-8">
              <ButtonLink
                variant="primary"
                size="lg"
                to={`/demo/w/${workspace.id}`}
              >
                Explore the sample workspace
                <ArrowRight aria-hidden="true" />
              </ButtonLink>
            </div>
            <small className="mt-5 text-[12px] text-muted-foreground">
              Workspace creation is coming next. This preview uses sample data.
            </small>
          </main>
        }
      />
      <Route path="w/:workspaceId/*" element={<WorkspaceShell />} />
      <Route
        path="*"
        element={
          <main className="mx-auto w-full max-w-2xl px-6 py-20">
            <EmptyState
              title="Page not found"
              action={
                <ButtonLink variant="primary" to="/">
                  Back home
                </ButtonLink>
              }
            >
              Check the address and try again.
            </EmptyState>
          </main>
        }
      />
    </Routes>
  );
}
