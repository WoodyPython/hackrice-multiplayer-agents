import { presenceRosterSchema, refreshHintSchema,
  type PresenceRoster, type RefreshHint } from '@app/contracts';

type Listener = (hint: RefreshHint | null) => void;
type RosterListener = (roster: PresenceRoster) => void;
const streams = new Map<string, {
  source: EventSource; listeners: Set<Listener>; rosters: Set<RosterListener>;
}>();

/** One connection per workspace per tab, shared by board, task and discussion. */
export function subscribeRefresh(workspaceId: string, listener: Listener): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  let stream = streams.get(workspaceId);
  if (!stream) {
    const source = new EventSource(`/api/workspaces/${encodeURIComponent(workspaceId)}/realtime/stream`);
    const listeners = new Set<Listener>();
    const rosters = new Set<RosterListener>();
    stream = { source, listeners, rosters };
    streams.set(workspaceId, stream);
    // Includes reconnect: always reconcile from the API, never trust hint state.
    source.addEventListener('ready', () => listeners.forEach((notify) => notify(null)));
    source.addEventListener('error', () => listeners.forEach((notify) => notify(null)));
    source.addEventListener('presence', (event) => {
      try {
        const roster = presenceRosterSchema.safeParse(JSON.parse((event as MessageEvent).data));
        if (roster.success && roster.data.workspaceId === workspaceId)
          rosters.forEach((notify) => notify(roster.data));
      } catch { /* A malformed roster leaves the previous one on screen. */ }
    });
    source.addEventListener('refresh', (event) => {
      try {
        const hint = refreshHintSchema.safeParse(JSON.parse((event as MessageEvent).data));
        if (hint.success && hint.data.workspaceId === workspaceId)
          listeners.forEach((notify) => notify(hint.data));
      } catch { /* Invalid hints cannot change state. Polling remains available. */ }
    });
  }
  stream.listeners.add(listener);
  return release(workspaceId, () => stream!.listeners.delete(listener));
}

/** Live roster for the workspace, over the same connection. */
export function subscribePresence(workspaceId: string, listener: RosterListener): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  // Reuses (or opens) the shared connection; the no-op refresh listener is what
  // keeps that connection alive for a caller that only wants presence.
  const detachRefresh = subscribeRefresh(workspaceId, () => {});
  streams.get(workspaceId)?.rosters.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    streams.get(workspaceId)?.rosters.delete(listener);
    detachRefresh();
  };
}

/** A connection closes only once nothing is listening for either kind. */
function release(workspaceId: string, detach: () => void): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    detach();
    const stream = streams.get(workspaceId);
    if (stream && !stream.listeners.size && !stream.rosters.size) {
      stream.source.close();
      streams.delete(workspaceId);
    }
  };
}

/** Serialize refreshes; a hint during a fetch guarantees one trailing fetch.
 * Do not abort/restart on every hint: under load that can starve rendering.
 */
export function refreshLoop(workspaceId: string, taskId: string | undefined,
  pull: () => Promise<void>, interval: () => number): () => void {
  let stopped = false;
  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped) return;
    if (running) { dirty = true; return; }
    if (timer) clearTimeout(timer);
    running = true;
    try { await pull(); }
    finally {
      running = false;
      if (!stopped) {
        // A healthy stream can still miss hints when transactions commit out of order.
        const delay = dirty ? 0 : interval();
        dirty = false;
        timer = setTimeout(() => void run(), delay);
      }
    }
  };
  const unsubscribe = subscribeRefresh(workspaceId, (hint) => {
    if (!hint || !taskId || !hint.taskId || hint.taskId === taskId) void run();
  });
  const wake = () => { if (document.visibilityState !== 'hidden') void run(); };
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    window.removeEventListener('online', wake);
    window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
