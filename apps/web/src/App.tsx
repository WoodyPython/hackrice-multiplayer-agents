import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { type TaskDetail as Task } from "@app/contracts";
import {
  createFixtureTask,
  initialTasks,
  summarize,
  workspace,
} from "./fixtures";
import { EmptyState } from "./components/EmptyState";
import { RequirementForm } from "./components/RequirementForm";
import { TaskBoard } from "./pages/TaskBoard";
import { TaskDetail } from "./pages/TaskDetail";

function TaskRoute({ tasks, base }: { tasks: Task[]; base: string }) {
  const { taskId } = useParams();
  const task = tasks.find((item) => item.id === taskId);
  return task ? (
    <TaskDetail key={task.id} task={task} base={base} />
  ) : (
    <EmptyState
      title="Task not found"
      action={
        <Link className="button" to={base}>
          Back to tasks
        </Link>
      }
    >
      This task isn't available in this workspace. Check the link or return to
      the board.
    </EmptyState>
  );
}

function WorkspaceShell() {
  const { workspaceId } = useParams();
  const [tasks, setTasks] = useState(initialTasks);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const base = `/w/${workspace.id}`;
  const view = search.get("view") ?? "sample";
  useEffect(() => {
    document.title = `${workspace.name} — Common`;
    document.getElementById("main")?.focus();
  }, [location.pathname]);
  if (workspaceId !== workspace.id)
    return (
      <main>
        <EmptyState
          title="Workspace not found"
          action={
            <Link className="button" to="/">
              Back home
            </Link>
          }
        >
          Check the workspace link or open the sample workspace.
        </EmptyState>
      </main>
    );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            c
          </span>
          common<span className="brand-period">.</span>
        </Link>
        <details className="workspace-menu">
          <summary>
            <span className="workspace-icon">L</span>
            <span>
              {workspace.name}
              <small>Shared workspace</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <Link to={`${base}/settings`}>Workspace settings</Link>
        </details>
        <span className="nav-caption">Workspace</span>
        <nav aria-label="Workspace">
          <NavLink to={base} end>
            <span aria-hidden="true">▦</span>Tasks
            <span className="nav-count">{tasks.length}</span>
          </NavLink>
          <NavLink to={`${base}/files`}>
            <span aria-hidden="true">▤</span>Files
          </NavLink>
          <NavLink to={`${base}/history`}>
            <span aria-hidden="true">◷</span>History
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="collaboration-note">
            <span aria-hidden="true">✳</span>
            <p>
              A shared space.
              <br />A little more possible.
            </p>
          </div>
          <span className="guest-label">
            <span className="avatar">M</span>Guest Maple
            <small>Guest contributor</small>
          </span>
        </div>
      </aside>
      <div className="main-shell">
        <div className="topbar">
          <span>
            Workspace <span className="breadcrumb-slash">/</span>{" "}
            {workspace.name}
          </span>
          <span className="preview-badge">
            <span />
            Sample workspace
          </span>
        </div>
        <div className="preview-strip">
          <span>Interactive preview · Changes last until you reload.</span>
          <label>
            Preview state{" "}
            <select
              aria-label="Preview state"
              value={view}
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
            </select>
          </label>
        </div>
        <main id="main" tabIndex={-1}>
          {view === "loading" ? (
            <section aria-busy="true" aria-label="Loading workspace">
              <p role="status">Loading workspace…</p>
              <div className="skeleton heading-skeleton" />
              <div className="skeleton-grid">
                {[0, 1, 2, 3, 4].map((index) => (
                  <div className="skeleton" key={index} />
                ))}
              </div>
            </section>
          ) : view === "error" ? (
            <EmptyState
              title="We couldn't load this workspace"
              action={<button onClick={() => setSearch({})}>Try again</button>}
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
                    <Link className="back-link" to={base}>
                      ← All tasks
                    </Link>
                    <header className="page-heading">
                      <div>
                        <span className="eyebrow">
                          From an idea to a shared task
                        </span>
                        <h1>What shall we work on?</h1>
                        <p>
                          Post the brief first. Decide when to start together.
                        </p>
                      </div>
                    </header>
                    <RequirementForm
                      onCancel={() => navigate(base)}
                      onPost={(request) => {
                        const task = createFixtureTask(request);
                        setTasks((previous) => [task, ...previous]);
                        navigate(`${base}/tasks/${task.id}`);
                      }}
                    />
                  </>
                }
              />
              <Route
                path="tasks/:taskId"
                element={<TaskRoute tasks={tasks} base={base} />}
              />
              <Route
                path="files"
                element={
                  <>
                    <header className="page-heading">
                      <div>
                        <span className="eyebrow">The shared library</span>
                        <h1>Files</h1>
                        <p>
                          Approved work, source material, and drafts in one
                          place.
                        </p>
                      </div>
                    </header>
                    <div className="library-grid">
                      {[
                        "Approved files",
                        "Reference materials",
                        "Active shared drafts",
                      ].map((title) => (
                        <section className="panel" key={title}>
                          <EmptyState title={title}>
                            File browsing and editing will connect in a later
                            ticket.
                          </EmptyState>
                        </section>
                      ))}
                    </div>
                  </>
                }
              />
              <Route
                path="history"
                element={
                  <>
                    <header className="page-heading">
                      <div>
                        <span className="eyebrow">A record of progress</span>
                        <h1>History</h1>
                      </div>
                    </header>
                    <EmptyState title="The story starts with your first change">
                      Applied changes and their associated tasks will appear
                      here when history is connected.
                    </EmptyState>
                  </>
                }
              />
              <Route
                path="settings"
                element={
                  <>
                    <header className="page-heading">
                      <div>
                        <span className="eyebrow">Workspace settings</span>
                        <h1>{workspace.name}</h1>
                        <p>{workspace.purpose}</p>
                      </div>
                    </header>
                    <section className="panel requirements">
                      <h2>Workspace guidance</h2>
                      <p>{workspace.guidance}</p>
                      <p className="muted">
                        Owner controls will be available when workspace creation
                        is connected.
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
                      <Link className="button" to={base}>
                        Back to tasks
                      </Link>
                    }
                  >
                    This page isn't available in the workspace preview.
                  </EmptyState>
                }
              />
            </Routes>
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <main className="welcome">
            <Link className="brand" to="/">
              <span className="brand-mark">c</span>common.
            </Link>
            <span className="eyebrow">A little more possible, together</span>
            <h1>
              Make room
              <br />
              for good work.
            </h1>
            <p>
              A shared place for your team's ideas, drafts, and the agents that
              help bring them to life.
            </p>
            <Link className="button primary" to={`/w/${workspace.id}`}>
              Explore the sample workspace →
            </Link>
            <small>
              Workspace creation is coming next. This preview uses sample data.
            </small>
          </main>
        }
      />
      <Route path="/w/:workspaceId/*" element={<WorkspaceShell />} />
      <Route
        path="*"
        element={
          <main>
            <EmptyState
              title="Page not found"
              action={
                <Link className="button" to="/">
                  Back home
                </Link>
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
