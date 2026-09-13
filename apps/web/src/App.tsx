import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Route, Routes, useLocation, useParams } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { ApiError, uuidSchema, type Workspace } from "@app/contracts";
import { BrowserContext, useBrowser } from "./browser-context";
import { BrowserSession } from "./session";
import { WorkspaceApi, workspaceError } from "./workspace-api";
import { DemoApp } from "./DemoApp";
import { AppShell, type NavItem } from "./components/AppShell";
import { EmptyState } from "./components/EmptyState";
import { GuestNameControl } from "./components/GuestNameControl";
import { PresencePanel } from "./components/PresencePanel";
import { usePresence } from "./presence";
import { ShareWorkspace } from "./components/ShareWorkspace";
import { Button, ButtonLink } from "./components/ui/button";
import { Notice, Skeleton } from "./components/ui/misc";
import { CreateWorkspace } from "./pages/CreateWorkspace";
import { WorkspaceSettings } from "./pages/WorkspaceSettings";
import { TaskDrafts } from "./pages/TaskDrafts";
import { TaskBoardPage } from "./pages/TaskBoardPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { NewTask } from "./pages/NewTask";
import { Files } from "./pages/Files";
import { ApprovedFile } from "./pages/ApprovedFile";
import { History } from "./pages/History";

function LiveWorkspace({ id }: { id: string }) {
  const { api, session } = useBrowser();
  const revision = useSyncExternalStore(session.subscribe, session.getRevision);
  // Per tab, not per contributor: two tabs are two open browsers and should
  // appear as such, and it must not survive a reload as a ghost.
  const [presenceId] = useState(() => crypto.randomUUID());
  const guest = session.getGuest();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const participants = usePresence(id, {
    presenceId,
    name: guest.name,
    color: guest.color,
    isHost: !!workspace?.isOwner && !!session.getOwnerKey(id),
  });
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
      ? `${workspace.name} — CoFlow`
      : "Workspace — CoFlow";
  }, [workspace?.name]);
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location.pathname]);
  if (!workspace && loading)
    return (
      <main aria-busy="true" className="mx-auto w-full max-w-5xl px-6 py-16">
        <p role="status" className="sr-only">
          Opening workspace…
        </p>
        <div aria-hidden="true" className="space-y-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-48" />
        </div>
      </main>
    );
  if (
    !workspace ||
    (failure instanceof ApiError && failure.code === "WORKSPACE_NOT_FOUND")
  )
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20">
        <EmptyState
          icon={TriangleAlert}
          title={
            failure instanceof ApiError &&
            failure.code === "WORKSPACE_NOT_FOUND"
              ? "Workspace not found"
              : "Workspace unavailable"
          }
          action={
            <>
              <Button onClick={() => setRetry((value) => value + 1)}>
                Try again
              </Button>
              <ButtonLink variant="primary" to="/">
                Back home
              </ButtonLink>
            </>
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
  const items: NavItem[] = [
    { to: base, label: "Tasks", icon: "board", end: true },
    { to: `${base}/files`, label: "Files", icon: "files" },
    { to: `${base}/history`, label: "History", icon: "history" },
  ];
  return (
    <AppShell
      workspaceName={workspace.name}
      settingsTo={`${base}/settings`}
      items={items}
      guestName={session.getGuest().name}
      guestRole={visibleWorkspace.isOwner ? "Host" : "Contributor"}
      profileControl={<GuestNameControl sidebar />}
      topbarEnd={
        <div className="flex items-center gap-2.5">
          <PresencePanel
            participants={participants}
            selfPresenceId={presenceId}
          />
          <ShareWorkspace id={id} />
        </div>
      }
    >
      {session.hasUnsavedOwner(id) && (
        <Notice
          role="alert"
          tone="warn"
          className="mb-6"
          title="Host access was not saved in this browser"
        >
          <p>
            Workspace created, but this browser could not save host access.
            Keep this tab open and retry saving before leaving.
          </p>
          <Button size="sm" onClick={() => session.retryOwnerSave(id)}>
            Retry saving host access
          </Button>
        </Notice>
      )}
      {!!failure && (
        <Notice role="alert" tone="warn" className="mb-6">
          <p>{workspaceError(failure)}</p>
          <Button size="sm" onClick={() => setRetry((value) => value + 1)}>
            Reload workspace
          </Button>
        </Notice>
      )}
      <Routes>
        <Route
          path="tasks/:taskId/drafts"
          element={<TaskDrafts workspaceId={id} />}
        />
        <Route
          index
          element={
            <TaskBoardPage
              workspace={workspace}

            />
          }
        />
        <Route path="tasks/new" element={<NewTask workspaceId={id} />} />
        <Route
          path="tasks/:taskId"
          element={
            <TaskDetailPage
              workspaceId={id}
              isOwner={visibleWorkspace.isOwner}
              participants={participants}
              presenceId={presenceId}
            />
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
        <Route path="files/view" element={<ApprovedFile workspaceId={id} />} />
        <Route path="files" element={<Files workspaceId={id} />} />
        <Route path="history" element={<History workspaceId={id} />} />
        <Route
          path="*"
          element={
            <EmptyState
              title="Page not found"
              action={
                <ButtonLink variant="primary" to={base}>
                  Back to workspace
                </ButtonLink>
              }
            >
              Check the address and try again.
            </EmptyState>
          }
        />
      </Routes>
    </AppShell>
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
    <main className="mx-auto w-full max-w-2xl px-6 py-20">
      <EmptyState
        icon={TriangleAlert}
        title="Workspace not found"
        action={
          <ButtonLink variant="primary" to="/">
            Back home
          </ButtonLink>
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
    </BrowserContext.Provider>
  );
}
