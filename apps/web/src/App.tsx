import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { ApiError, uuidSchema, type Workspace } from "@app/contracts";
import { BrowserContext, useBrowser } from "./browser-context";
import { BrowserSession } from "./session";
import { WorkspaceApi, workspaceError } from "./workspace-api";
import { DemoApp } from "./DemoApp";
import { AuthProvider, useAuth } from "./auth-context";
import type { AuthApi } from "./auth-api";
import { SignIn } from "./pages/SignIn";
import { AcceptInvite } from "./pages/AcceptInvite";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { AccountMenu } from "./components/AccountMenu";
import { ClaimWorkspace } from "./components/ClaimWorkspace";
import { AppShell, type NavItem } from "./components/AppShell";
import { EmptyState } from "./components/EmptyState";
import { GuestNameControl } from "./components/GuestNameControl";
import { PresencePanel } from "./components/PresencePanel";
import { usePresence } from "./presence";
import { ShareWorkspace } from "./components/ShareWorkspace";
import { Button, ButtonLink } from "./components/ui/button";
import { Notice, Skeleton } from "./components/ui/misc";
import { CreateWorkspace } from "./pages/CreateWorkspace";
import { Home } from "./pages/Home";
import { WorkspaceSettings } from "./pages/WorkspaceSettings";
import { TaskDrafts } from "./pages/TaskDrafts";
import { TaskBoardPage } from "./pages/TaskBoardPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { NewTask } from "./pages/NewTask";
import { Files } from "./pages/Files";
import { ApprovedFile } from "./pages/ApprovedFile";
import { History } from "./pages/History";
import { Overview } from "./pages/Overview";
import { Agents } from "./pages/Agents";
import { Inbox } from "./pages/Inbox";
import { useInbox } from "./inbox";

function LiveWorkspace({ id }: { id: string }) {
  const { api, session } = useBrowser();
  const { account, workspaces, loading: authLoading, setPreferences } = useAuth();
  // Subscribed so a rename -- or signing in, which adopts the account's name --
  // re-renders the name shown in the sidebar and broadcast to presence.
  useSyncExternalStore(session.subscribe, session.getRevision);
  // Per tab, not per contributor: two tabs are two open browsers and should
  // appear as such, and it must not survive a reload as a ghost.
  const [presenceId] = useState(() => crypto.randomUUID());
  const guest = session.getGuest();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const inbox = useInbox(id, !!workspace);
  const [failure, setFailure] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const participants = usePresence(id, {
    presenceId,
    name: guest.name,
    color: guest.color,
  });
  const location = useLocation();
  const base = `/w/${id}`;
  useEffect(() => {
    if (authLoading) return;
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
    // Re-read when the account changes, because `access` is resolved per
    // caller and signing in is exactly what turns a viewer into an owner.
    //
    // Deliberately NOT keyed on the browser session's revision. It used to be:
    // the read once carried an owner key from storage, so a change there could
    // change the answer. It carries no per-browser secret now, and leaving the
    // dependency in meant renaming yourself -- or signing in, which adopts the
    // account's name -- silently refetching the whole workspace.
  }, [api, id, retry, account?.id, authLoading]);
  useEffect(() => {
    document.title = workspace
      ? `${workspace.name} — CoFlow`
      : "Workspace — CoFlow";
  }, [workspace?.name]);
  // Follows the account rather than this browser, so the next device opens
  // where the last one left off. Only recorded for a workspace you belong to;
  // the server refuses to store a pointer to one you merely visited.
  useEffect(() => {
    if (account && workspaces.some((item) => item.workspaceId === id)) {
      void setPreferences({ lastWorkspace: id });
    }
  }, [account, workspaces, id, setPreferences]);
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
  /**
   * Ownership is the membership row the server resolved on this very read.
   *
   * It used to also require a legacy owner key in this browser's storage. That
   * key is no longer minted -- an account-owned workspace has none at all -- so
   * the condition was never true, and the person who created the workspace
   * could not open its settings, see the member list, or invite anybody.
   *
   * `access` is read rather than `isOwner` because it is the same answer with
   * the other two levels attached, and the read is the moment it was true:
   * `!loading && !failure` keeps a stale or failed refresh from leaving an
   * owner form enabled. No check on `account` -- a caller without one can never
   * come back as `owner`, and testing for it only makes the controls flicker
   * while the session is still loading.
   *
   * Advisory either way: every owner-only route is re-checked by the
   * authorization hook, so this decides what is drawn and nothing else.
   */
  const isOwner = workspace.access === "owner" && !loading && !failure;
  const archived = workspace.status === "archived";
  // A failed refresh hides the badge rather than advertising a stale count.
  const inboxCount = inbox.failure ? undefined : inbox.items?.length;
  const inboxLabel = inboxCount === undefined ? undefined
    : `${inboxCount} actionable ${inboxCount === 1 ? "item" : "items"}`;
  const items: NavItem[] = [
    { to: `${base}/overview`, label: "Overview", icon: "overview" },
    { to: `${base}/inbox`, label: "Inbox", icon: "inbox", count: inboxCount, countLabel: inboxLabel },
    { to: base, label: "Tasks", icon: "board", end: true },
    { to: `${base}/agents`, label: "Agents", icon: "agents" },
    { to: `${base}/files`, label: "Files", icon: "files" },
    { to: `${base}/history`, label: "History", icon: "history" },
  ];
  return (
    <AppShell
      workspaceName={workspace.name}
      // A link holder has nothing to do on the settings page: the member list
      // is not theirs to read and every control there would refuse them.
      settingsTo={workspace.access === "viewer" ? undefined : `${base}/settings`}
      items={items}
      guestName={session.getGuest().name}
      switcher={
        account ? (
          <WorkspaceSwitcher
            workspaces={workspaces}
            currentId={id}
            currentName={workspace.name}
          />
        ) : undefined
      }
      guestRole={
        isOwner ? "Host" : workspace.access === "member" ? "Member" : "Viewing by link"
      }
      // Signed in, the name is the account's and is not editable here; signed
      // out it is the browser label other people see in a live document, which
      // is exactly the thing this control renames.
      profileControl={account ? <AccountMenu sidebar /> : <GuestNameControl sidebar />}
      topbarEnd={
        /*
          No account control here: the sidebar footer already carries the
          signed-in name, the address, and Sign out, next to the workspace role
          it belongs with. Two of them in one screen only makes the reader
          choose between them.
        */
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <PresencePanel
            participants={participants}
            selfPresenceId={presenceId}
          />
          <ShareWorkspace id={id} />
        </div>
      }
    >
      {/* Inbox count, announced without stealing focus. */}
      <p role="status" aria-atomic="true" className="sr-only">
        {inboxLabel ? `${inboxLabel} in Inbox` : ''}
      </p>
      {/*
        The "host access was not saved in this browser" warning that used to
        live here is gone with the thing it warned about: being the Host is a
        membership row now, so clearing storage loses nothing.

        What replaces it is the other direction -- a workspace made before
        accounts, which somebody holding its key can bring across.
      */}
      {account && workspace.unclaimed && !isOwner && (
        <ClaimWorkspace
          workspaceId={id}
          workspaceName={workspace.name}
          onClaimed={() => setRetry((value) => value + 1)}
        />
      )}
      {/*
        Said once, at the top, rather than by every control that will refuse.
        An archived workspace reads normally and writes nowhere, and the server
        enforces that in the authorization hook — this is the explanation, not
        the enforcement.
      */}
      {archived && (
        <Notice role="status" tone="warn" className="mb-6" title="This workspace is archived">
          <p>
            Everything here is still readable, and nothing can be changed until
            it is restored.
            {isOwner ? " You can restore it in workspace settings." : " Ask a host to restore it."}
          </p>
          {isOwner && (
            <ButtonLink size="sm" to={`${base}/settings`}>
              Open workspace settings
            </ButtonLink>
          )}
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
        <Route path="inbox" element={<Inbox workspaceId={id} state={inbox} />} />
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
              isOwner={isOwner}
              participants={participants}
              presenceId={presenceId}
            />
          }
        />
        <Route
          path="settings"
          element={
            <WorkspaceSettings
              workspace={{ ...workspace, isOwner }}
              onChange={setWorkspace}
            />
          }
        />
        <Route path="files/view" element={<ApprovedFile workspaceId={id} />} />
        <Route path="files" element={<Files workspaceId={id} />} />
        <Route path="history" element={<History workspaceId={id} />} />
        <Route path="overview" element={<Overview workspaceId={id} />} />
        <Route path="agents" element={<Agents workspaceId={id} />} />
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
  authApi,
}: {
  session?: BrowserSession;
  api?: WorkspaceApi;
  /** Injectable so tests can render as a signed-in account. */
  authApi?: AuthApi;
} = {}) {
  const [session] = useState(() => injectedSession ?? new BrowserSession());
  const api = useMemo(
    () => injectedApi ?? new WorkspaceApi(session),
    [session, injectedApi],
  );
  useEffect(() => session.connect(), [session]);
  return (
    <BrowserContext.Provider value={{ session, api }}>
      <AuthProvider {...(authApi ? { api: authApi } : {})}>
      <AdoptAccountName />
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        {/*
          Home is the account's list of workspaces; the landing page is what a
          signed-out visitor sees at the same address. One route rather than a
          redirect: bouncing somebody who is already signed in through a
          marketing page to reach their own work is a step nobody wants.
        */}
        <Route path="/" element={<HomeOrLanding />} />
        <Route
          path="/new"
          element={
            <RequireAccount>
              <CreateWorkspace />
            </RequireAccount>
          }
        />
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
      </AuthProvider>
    </BrowserContext.Provider>
  );
}

/**
 * Bridges the account into the browser-local display identity.
 *
 * Sits inside both providers because that is the only place that can see both.
 * Once signed in, presence, document cursors, discussion authorship and
 * uploaded-file attribution all show the account's name rather than "Guest
 * Maple" -- one call instead of eleven call sites each learning about accounts,
 * and one fewer way for the app to contradict itself about who you are.
 */
function AdoptAccountName() {
  const { session } = useBrowser();
  const { account } = useAuth();
  useEffect(() => {
    session.setAccountName(account?.displayName ?? null);
  }, [session, account?.displayName]);
  return null;
}

/**
 * `/` for everybody: the account's workspaces, or the landing page.
 *
 * `loading` is held distinct from "signed out" here for the same reason it is
 * in `RequireAccount` — showing a returning person the marketing page for a
 * frame before their list appears reads as having been signed out.
 */
function HomeOrLanding() {
  const { account, loading } = useAuth();
  if (loading)
    return (
      <main aria-busy="true" className="mx-auto w-full max-w-2xl px-6 py-20">
        <p role="status" className="sr-only">
          Checking your session…
        </p>
      </main>
    );
  return account ? <Home /> : <CreateWorkspace />;
}

/**
 * Gate for screens that make no sense without an account.
 *
 * Presentation only, as ever: every route behind it is enforced by the server
 * too. `loading` is held distinct from "signed out" so a refresh does not
 * bounce a signed-in person to the sign-in page for a frame.
 */
function RequireAccount({ children }: { children: ReactNode }) {
  const { account, loading, error, refresh } = useAuth();
  const [retrying, setRetrying] = useState(false);
  const location = useLocation();
  if (loading || retrying)
    return (
      <main aria-busy="true" className="mx-auto w-full max-w-2xl px-6 py-20">
        <p role="status" className="sr-only">
          Checking your session…
        </p>
      </main>
    );
  if (!account && error)
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20">
        <Notice role="alert" tone="warn" title="Session unavailable">
          <p>{error}</p>
          <Button onClick={() => {
            setRetrying(true);
            void refresh().catch(() => {}).finally(() => setRetrying(false));
          }}>Try again</Button>
        </Notice>
      </main>
    );
  if (!account)
    return (
      <Navigate
        replace
        to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`}
      />
    );
  return <>{children}</>;
}
