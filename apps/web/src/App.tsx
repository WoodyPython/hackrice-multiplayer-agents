import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { ApiError, uuidSchema, type Workspace } from "@app/contracts";
import { BrowserContext, useBrowser } from "./browser-context";
import { BrowserSession } from "./session";
import {
  contributionLink,
  WorkspaceApi,
  workspaceError,
} from "./workspace-api";
import { DemoApp } from "./DemoApp";
import { EmptyState } from "./components/EmptyState";
import { GuestNameControl } from "./components/GuestNameControl";
import { CreateWorkspace } from "./pages/CreateWorkspace";
import { WorkspaceSettings } from "./pages/WorkspaceSettings";

function ShareWorkspace({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const link = contributionLink(id);
  return (
    <div className="share-workspace">
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setManual(false);
          } catch {
            setManual(true);
            setCopied(false);
          }
        }}
      >
        Copy workspace link
      </button>
      {copied && (
        <small role="status">Link copied. Anyone with it can contribute.</small>
      )}
      {manual && (
        <label>
          Copy this contribution link
          <input
            readOnly
            value={link}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
    </div>
  );
}

function LiveWorkspace({ id }: { id: string }) {
  const { api, session } = useBrowser();
  const revision = useSyncExternalStore(session.subscribe, session.getRevision);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const base = `/w/${id}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    api
      .read(id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setWorkspace(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, id, revision, retry]);
  useEffect(() => {
    document.title = workspace
      ? `${workspace.name} — Common`
      : "Workspace — Common";
  }, [workspace?.name]);
  useEffect(() => {
    document.getElementById("main")?.focus();
  }, [location.pathname]);
  if (!workspace && loading)
    return (
      <main aria-busy="true">
        <p role="status">Opening workspace…</p>
        <div className="skeleton heading-skeleton" />
      </main>
    );
  if (
    !workspace ||
    (failure instanceof ApiError && failure.code === "WORKSPACE_NOT_FOUND")
  )
    return (
      <main>
        <EmptyState
          title={
            failure instanceof ApiError &&
            failure.code === "WORKSPACE_NOT_FOUND"
              ? "Workspace not found"
              : "Workspace unavailable"
          }
          action={
            <div className="actions">
              <button onClick={() => setRetry((value) => value + 1)}>
                Try again
              </button>
              <Link className="button" to="/">
                Back home
              </Link>
            </div>
          }
        >
          {workspaceError(failure)}
        </EmptyState>
      </main>
    );
  // Server ownership is authoritative; stale reads never leave an owner form enabled.
  const visibleWorkspace = {
    ...workspace,
    isOwner:
      workspace.isOwner && !loading && !failure && !!session.getOwnerKey(id),
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">c</span>common.
        </Link>
        <details className="workspace-menu">
          <summary>
            <span className="workspace-icon">{workspace.name[0]}</span>
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
            ▦ Tasks
          </NavLink>
          <NavLink to={`${base}/files`}>▤ Files</NavLink>
          <NavLink to={`${base}/history`}>◷ History</NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="collaboration-note">
            <p>
              A shared space.
              <br />A little more possible.
            </p>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar live-topbar">
          <span>
            {workspace.name} ·{" "}
            {visibleWorkspace.isOwner ? "Owner" : "Contributor"}
          </span>
          <GuestNameControl />
        </header>
        <main id="main" tabIndex={-1}>
          {session.hasUnsavedOwner(id) && (
            <div className="storage-notice" role="alert">
              <p>
                Workspace created, but this browser could not save owner access.
                Keep this tab open and retry saving before leaving.
              </p>
              <button onClick={() => session.retryOwnerSave(id)}>
                Retry saving owner access
              </button>
            </div>
          )}
          {!!failure && (
            <div role="alert">
              <p>{workspaceError(failure)}</p>
              <button onClick={() => setRetry((value) => value + 1)}>
                Reload workspace
              </button>
            </div>
          )}
          <Routes>
            <Route
              index
              element={
                <>
                  <header className="page-heading">
                    <div>
                      <span className="eyebrow">Your shared workspace</span>
                      <h1>{workspace.name}</h1>
                      <p>
                        {workspace.purpose || "A place to shape work together."}
                      </p>
                    </div>
                    <ShareWorkspace id={id} />
                  </header>
                  <div className="board-toolbar">
                    <h2>Task board</h2>
                  </div>
                  <EmptyState title="Your workspace is ready">
                    Share the link to invite collaborators. Task posting will be
                    connected in the next task-workflow ticket.
                  </EmptyState>
                </>
              }
            />
            <Route
              path="settings"
              element={
                <WorkspaceSettings
                  workspace={visibleWorkspace}
                  onChange={setWorkspace}
                />
              }
            />
            <Route
              path="files"
              element={
                <>
                  <h1>Files</h1>
                  <EmptyState title="Your shared library">
                    Approved files, reference materials, and shared drafts will
                    appear here when file browsing is connected.
                  </EmptyState>
                </>
              }
            />
            <Route
              path="history"
              element={
                <>
                  <h1>History</h1>
                  <EmptyState title="A record of progress">
                    Applied changes will appear here when history is connected.
                  </EmptyState>
                </>
              }
            />
            <Route
              path="tasks/*"
              element={
                <EmptyState
                  title="Task workflow is coming next"
                  action={
                    <Link className="button" to={base}>
                      Back to workspace
                    </Link>
                  }
                >
                  Task posting and discussion are not yet connected in this
                  workspace.
                </EmptyState>
              }
            />
            <Route
              path="*"
              element={
                <EmptyState
                  title="Page not found"
                  action={
                    <Link className="button" to={base}>
                      Back to workspace
                    </Link>
                  }
                >
                  Check the address and try again.
                </EmptyState>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function WorkspaceRoute() {
  const { workspaceId } = useParams();
  const parsed = uuidSchema.safeParse(workspaceId);
  return parsed.success ? (
    <LiveWorkspace
      key={parsed.data.toLowerCase()}
      id={parsed.data.toLowerCase()}
    />
  ) : (
    <main>
      <EmptyState
        title="Workspace not found"
        action={
          <Link className="button" to="/">
            Back home
          </Link>
        }
      >
        Check the contribution link.
      </EmptyState>
    </main>
  );
}

export function App({
  session: injectedSession,
  api: injectedApi,
}: { session?: BrowserSession; api?: WorkspaceApi } = {}) {
  const [session] = useState(() => injectedSession ?? new BrowserSession());
  const api = useMemo(
    () => injectedApi ?? new WorkspaceApi(session),
    [session, injectedApi],
  );
  useEffect(() => session.connect(), [session]);
  return (
    <BrowserContext.Provider value={{ session, api }}>
      <Routes>
        <Route path="/" element={<CreateWorkspace />} />
        <Route path="/w/:workspaceId/*" element={<WorkspaceRoute />} />
        <Route path="/demo/*" element={<DemoApp />} />
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
    </BrowserContext.Provider>
  );
}
