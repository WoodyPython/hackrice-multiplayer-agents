import { useCallback, useEffect, useState } from 'react';
import type { InboxItem } from '@app/contracts';
import { useBrowser } from './browser-context';
import { refreshLoop } from './realtime';
import { apiMessage } from './workspace-api';

/** Mounted once in the workspace shell: page and badge share one snapshot. */
export function useInbox(workspaceId: string, enabled = true) {
  const { api } = useBrowser();
  const [snapshot, setSnapshot] = useState<{
    workspaceId: string; items: InboxItem[] | null; failure: string | null;
  }>({ workspaceId, items: null, failure: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const stop = refreshLoop(workspaceId, undefined, async () => {
      try {
        const items = await api.listInbox(workspaceId, controller.signal);
        if (!controller.signal.aborted) setSnapshot({ workspaceId, items, failure: null });
      } catch (error) {
        if (!controller.signal.aborted) setSnapshot((previous) => ({
          workspaceId, items: previous.workspaceId === workspaceId ? previous.items : null,
          failure: apiMessage(error),
        }));
      }
    }, () => 5000);
    return () => { controller.abort(); stop(); };
  }, [api, workspaceId, nonce, enabled]);
  const current = snapshot.workspaceId === workspaceId ? snapshot : { items: null, failure: null };
  return { ...current, reload };
}
export type InboxState = ReturnType<typeof useInbox>;
