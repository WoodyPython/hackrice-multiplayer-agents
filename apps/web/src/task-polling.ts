import type { DiscussionEntry, TaskEvent } from '@app/contracts';
import type { WorkspaceApi } from './workspace-api';

/** Advance from returned rows, never the server's global high-water mark. */
export async function readEventPages(api: WorkspaceApi, workspaceId: string, taskId: string,
  previous: TaskEvent[], signal: AbortSignal): Promise<TaskEvent[]> {
  const events = new Map(previous.map((event) => [event.id, event]));
  let cursor = previous.at(-1)?.id;
  while (!signal.aborted) {
    const page = await api.listTaskEvents(workspaceId, taskId, cursor, signal);
    const next = page.events.at(-1)?.id;
    for (const event of page.events) events.set(event.id, event);
    if (!next || next === cursor || !page.latestId || BigInt(next) >= BigInt(page.latestId)) break;
    cursor = next;
  }
  signal.throwIfAborted();
  return [...events.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

/** Entries carry mutable questions and cutoff labels, so refresh every page. */
export async function readDiscussionPages(api: WorkspaceApi, workspaceId: string, taskId: string, signal: AbortSignal) {
  const entries = new Map<string, DiscussionEntry>();
  let cursor = 0;
  let page;
  do {
    page = await api.listDiscussion(workspaceId, taskId, cursor, signal);
    const next = page.entries.at(-1)?.seq;
    for (const entry of page.entries) entries.set(entry.id, entry);
    if (next === undefined || next <= cursor || next >= page.latestSeq) break;
    cursor = next;
  } while (!signal.aborted);
  signal.throwIfAborted();
  return { ...page, entries: [...entries.values()].sort((a, b) => a.seq - b.seq) };
}
