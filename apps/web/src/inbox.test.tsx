import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItem } from '@app/contracts';
import { App } from './App';
import { stubAuthApi } from './test-auth';
import { BrowserSession } from './session';
import { WorkspaceApi } from './workspace-api';
import { workspace as sample } from './fixtures';
import { BrowserContext } from './browser-context';
import { useInbox } from './inbox';

const id = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const taskId = '20000000-0000-4000-8000-000000000001';
const rows: InboxItem[] = ['question', 'review', 'failed_run', 'blocker'].map((type, i) => ({
  id: `${type}:${i}`, type: type as InboxItem['type'], taskId, taskTitle: `Task ${i + 1}`,
  timestamp: '2026-09-13T10:00:00.000Z', summary: `Issue ${i + 1}`,
  questionId: type === 'question' ? taskId : null, reviewId: type === 'review' ? taskId : null, runId: null,
}));
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(read: () => Promise<Response> | Response) {
  const session = new BrowserSession();
  const transport = vi.fn<typeof fetch>(async (input) => {
    if (String(input) === `/api/workspaces/${id}`) return json({ ...sample, id, isOwner: false });
    if (String(input).endsWith('/inbox')) return read();
    return json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Not found' } }, 404);
  });
  render(<MemoryRouter initialEntries={[`/w/${id}/inbox`]}><App session={session} api={new WorkspaceApi(session, transport)} authApi={stubAuthApi()} /></MemoryRouter>);
  return transport;
}
beforeEach(() => localStorage.clear());

it('shares the aggregate badge with the page, filters by type, and links to existing task actions', async () => {
  const transport = fixture(() => json({ items: rows }));
  const list = await screen.findByRole('list', { name: 'Actionable items' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  const nav = screen.getByRole('navigation', { name: 'Workspace' });
  expect(within(nav).getByRole('link', { name: 'Inbox, 4 actionable items' }).getAttribute('href')).toBe(`/w/${id}/inbox`);
  expect(screen.getByRole('link', { name: 'Answer question' }).getAttribute('href')).toContain('?tab=Discussion');
  expect(screen.getByRole('link', { name: 'Review task' }).getAttribute('href')).toContain('?tab=Changes');
  expect(screen.getByRole('link', { name: 'Inspect run' }).getAttribute('href')).toContain('?tab=Agents');
  expect(list.querySelectorAll('time[datetime]')).toHaveLength(4);
  fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'question' } });
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  expect(within(nav).getByRole('link', { name: 'Inbox, 4 actionable items' })).toBeTruthy();
  expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/inbox'))).toHaveLength(1);
});

it('removes resolved issues and updates the badge on the existing focus refresh mechanism', async () => {
  let items = rows;
  fixture(() => json({ items }));
  await screen.findByRole('list', { name: 'Actionable items' });
  items = [];
  fireEvent(window, new Event('focus'));
  await screen.findByText('You’re all caught up');
  expect(screen.getByRole('link', { name: 'Inbox, 0 actionable items' })).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Actionable items' })).toBeNull();
});

it('shows loading, then a retryable error without claiming an empty inbox', async () => {
  let settle!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { settle = resolve; });
  let response = () => pending;
  fixture(() => response());
  await screen.findByText('Loading inbox…');
  await act(async () => settle(json({ error: { code: 'INTERNAL_ERROR', message: 'private server detail' } }, 500)));
  await screen.findByRole('alert');
  expect(screen.queryByText('Loading inbox…')).toBeNull();
  expect(screen.queryByText('You’re all caught up')).toBeNull();
  expect(screen.queryByText('private server detail')).toBeNull();
  response = async () => json({ items: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('You’re all caught up');
});

it('labels a stale snapshot on refresh failure and does not advertise an authoritative badge', async () => {
  let failed = false;
  fixture(() => failed ? json({ error: { code: 'INTERNAL_ERROR', message: 'failed' } }, 500) : json({ items: rows }));
  await screen.findByRole('list', { name: 'Actionable items' });
  failed = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
  await screen.findByText(/Showing the last loaded items/);
  expect(screen.getByRole('link', { name: 'Inbox' })).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(4);
});

it('shows a filtered empty state without hiding the workspace count', async () => {
  fixture(() => json({ items: rows.slice(0, 1) }));
  await screen.findByRole('list', { name: 'Actionable items' });
  fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'review' } });
  await screen.findByText('No items of this type');
  expect(screen.getByRole('link', { name: 'Inbox, 1 actionable item' })).toBeTruthy();
});

it('never shows the previous workspace snapshot or accepts its late response after switching', async () => {
  const session = new BrowserSession();
  const api = new WorkspaceApi(session);
  let resolveOld!: (items: InboxItem[]) => void;
  let resolveNew!: (items: InboxItem[]) => void;
  vi.spyOn(api, 'listInbox').mockImplementation((workspaceId) => new Promise((resolve) => {
    if (workspaceId === id) resolveOld = resolve; else resolveNew = resolve;
  }));
  function Harness({ workspaceId }: { workspaceId: string }) {
    const { items } = useInbox(workspaceId);
    return <p>{items ? items.map((item) => item.taskTitle).join(',') || 'Empty' : 'Loading'}</p>;
  }
  const tree = (workspaceId: string) => <BrowserContext.Provider value={{ api, session }}><Harness workspaceId={workspaceId} /></BrowserContext.Provider>;
  const view = render(tree(id));
  await act(async () => resolveOld(rows));
  expect(screen.getByText(/Task 1/)).toBeTruthy();
  fireEvent(window, new Event('focus'));
  view.rerender(tree(otherId));
  expect(screen.queryByText(/Task 1/)).toBeNull();
  await act(async () => resolveOld(rows));
  expect(screen.queryByText(/Task 1/)).toBeNull();
  await act(async () => resolveNew([]));
  await waitFor(() => expect(screen.getByText('Empty')).toBeTruthy());
});
