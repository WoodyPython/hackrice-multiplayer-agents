import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { type TaskAttempt, type TaskEvent, type TaskSummary } from '@app/contracts';
import { App } from './App';
import { stubAuthApi } from './test-auth';
import { BrowserSession } from './session';
import { WorkspaceApi } from './workspace-api';
import { initialTasks, workspace } from './fixtures';
import { TaskDetail } from './pages/TaskDetail';
import { agentOutputPaths, eventsForAgent } from './agents';

const id = workspace.id;
const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskId = uuid(1), runId = uuid(2), oldRunId = uuid(3), agentId = uuid(4), oldAgentId = uuid(5);
const timestamp = '2026-09-13T10:00:00Z';
const task: TaskSummary = { id: taskId, workspaceId: id, kind: 'agent_task', title: 'Draft launch notes',
  outcome: '', criteria: [], version: 1, status: 'completed', creatorGuestLabel: 'Guest', activeRunId: runId,
  materialCount: 0, discussionCount: 0, openQuestionCount: 0, updatedAt: timestamp };
const attempt: TaskAttempt = { runId, attempt: 2, status: 'working', taskVersion: 1, createdAt: timestamp, endedAt: null,
  assignments: [{ id: agentId, runId, taskId, agentKey: 'writer', assignmentKey: 'write-notes', preset: 'writer',
    status: 'running', instructionSummary: 'Write clear launch notes.', writePaths: ['docs/notes.md', 'docs/unwritten.md'],
    dependsOn: [], baseSha: null, resultSha: 'a'.repeat(40), startedAt: timestamp,
    deadlineAt: '2026-09-13T10:10:00Z', endedAt: null }] };
const oldAttempt: TaskAttempt = { ...attempt, runId: oldRunId, attempt: 1, status: 'incomplete', endedAt: timestamp,
  assignments: [{ ...attempt.assignments[0]!, id: oldAgentId, runId: oldRunId, status: 'timed_out', endedAt: timestamp }] };
const event = (n: number, overrides: Partial<TaskEvent> = {}): TaskEvent => ({ id: String(n), taskId, runId,
  type: 'agent.started', payload: { agentId }, createdAt: timestamp, ...overrides });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const failure = () => response({ error: { code: 'INTERNAL_ERROR', message: 'SECRET SERVER TEXT' } }, 500);

class Source extends EventTarget {
  static instances: Source[] = [];
  close = vi.fn();
  constructor(readonly url: string) { super(); Source.instances.push(this); }
  hint(workspaceId = id) { this.dispatchEvent(new MessageEvent('refresh', { data: JSON.stringify({
    workspaceId, taskId, eventType: 'agent.completed', eventId: '20',
  }) })); }
}

function mount(options: { tasks?: () => Response | Promise<Response>; agents?: (path: string) => Response | Promise<Response>;
  events?: (path: string) => Response; outputs?: () => Response; owner?: boolean } = {}) {
  const session = new BrowserSession();
  if (options.owner) session.saveOwner(id, 'owner-test-secret-123456789');
  const transport = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === `/api/workspaces/${id}`) return response({ ...workspace, isOwner: !!options.owner });
    if (url.pathname === `/api/workspaces/${id}/tasks`) return options.tasks?.() ?? response({ tasks: [task] });
    if (url.pathname.endsWith('/agents')) return options.agents?.(url.pathname) ?? response({ attempts: [attempt, oldAttempt] });
    if (url.pathname.endsWith('/events')) return options.events?.(url.pathname) ?? response({ events: [event(1)], latestId: '1' });
    if (url.pathname.endsWith('/saved-outputs')) return options.outputs?.() ?? response({ outputs: [
      { runId: oldRunId, agentInstanceId: oldAgentId, path: 'docs/notes.md', commitSha: 'a'.repeat(40) },
    ] });
    return response({}, 404);
  });
  const rendered = render(<MemoryRouter initialEntries={[`/w/${id}/agents`]}><App session={session} api={new WorkspaceApi(session, transport)} authApi={stubAuthApi()} /></MemoryRouter>);
  return { transport, ...rendered };
}

beforeEach(() => { localStorage.clear(); Source.instances = []; vi.stubGlobal('EventSource', Source); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('workspace Agents page', () => {
  it('shows agents on multiple tasks, including a newly started run and a report without file outputs', async () => {
    const secondTask = { ...task, id: uuid(30), title: 'Review scope', activeRunId: null };
    const secondAgent = { ...attempt.assignments[0]!, id: uuid(31), taskId: secondTask.id, runId: uuid(32),
      assignmentKey: 'review-scope', preset: 'analyst', status: 'completed', writePaths: [] };
    mount({ tasks: () => response({ tasks: [{ ...task, activeRunId: null }, secondTask] }),
      agents: (path) => response({ attempts: path.includes(secondTask.id)
        ? [{ ...attempt, runId: secondAgent.runId, status: 'completed', assignments: [secondAgent] }] : [attempt] }),
      events: (path) => response({ events: path.includes(secondTask.id) ? [event(2, { taskId: secondTask.id,
        runId: secondAgent.runId, type: 'agent.completed', payload: { agentId: secondAgent.id,
          result: { summary: 'The scope meets all criteria.' } } })] : [event(1)], latestId: '2' }),
      outputs: () => response({ outputs: [] }),
    });
    const active = await screen.findByRole('region', { name: 'Active runs' });
    expect(within(active).getByRole('link', { name: task.title })).toBeTruthy();
    const past = screen.getByRole('region', { name: 'Past attempts' });
    expect(within(past).getByRole('link', { name: secondTask.title })).toBeTruthy();
    expect(within(past).getByText('Read result summary')).toBeTruthy();
    expect(within(active).queryByText('Read result summary')).toBeNull();
    expect(within(past).getByText('The scope meets all criteria.')).toBeTruthy();
  });

  it('uses actual run and agent states, groups retries, and exposes only read actions for contributors and hosts', async () => {
    const { transport } = mount();
    const active = await screen.findByRole('region', { name: 'Active runs' });
    const past = screen.getByRole('region', { name: 'Past attempts' });
    expect(within(active).getByText('Run: working')).toBeTruthy(); // Task says completed, deadline is past.
    expect(within(active).getByText('running', { selector: 'span' })).toBeTruthy();
    expect(within(past).getByText('timed out', { selector: 'span' })).toBeTruthy();
    expect(within(past).getByText('Saved output')).toBeTruthy();
    expect(within(active).getByText('No saved output recorded.')).toBeTruthy();
    expect(within(active).getByRole('link', { name: task.title }).getAttribute('href')).toContain('?tab=Agents&from=agents');
    const nav = screen.getByRole('navigation', { name: 'Workspace' });
    expect(within(nav).getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: /pause|resume|stop|cancel|retry task/i })).toBeNull();
    expect(transport.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('filters by agent state, including timeout, and distinguishes no matches', async () => {
    mount({ owner: true });
    const select = await screen.findByLabelText('Agent status');
    await userEvent.selectOptions(select, 'timed_out');
    expect(screen.queryByText('running', { selector: 'span' })).toBeNull();
    expect(screen.getByText('timed out', { selector: 'span' })).toBeTruthy();
    await userEvent.selectOptions(select, 'failed');
    expect(screen.getByText('No agents match this status')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /pause|resume|stop|cancel/i })).toBeNull();
  });

  it('shows initial loading, then an honest empty state', async () => {
    let resolve!: (value: Response) => void;
    mount({ tasks: () => new Promise((done) => { resolve = done; }) });
    expect(await screen.findByText('Loading agents…')).toBeTruthy();
    await act(async () => resolve(response({ tasks: [] })));
    expect(await screen.findByText('No agents yet')).toBeTruthy();
    expect(screen.queryByText('Loading agents…')).toBeNull();
  });

  it('keeps planning runs visible before assignments exist', async () => {
    mount({ agents: () => response({ attempts: [{ ...attempt, status: 'planning', assignments: [] }] }) });
    expect(await screen.findByText('No agents have been assigned yet.')).toBeTruthy();
    expect(screen.queryByText('No agents yet')).toBeNull();
  });

  it('recovers from failure without showing server text or an empty-state lie', async () => {
    let broken = true;
    mount({ tasks: () => broken ? failure() : response({ tasks: [] }) });
    expect(await screen.findByText('Could not load agents')).toBeTruthy();
    expect(screen.queryByText('SECRET SERVER TEXT')).toBeNull();
    expect(screen.queryByText('No agents yet')).toBeNull();
    broken = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No agents yet')).toBeTruthy();
  });

  it('retains statuses when activity/output reads fail and identifies missing data', async () => {
    mount({ events: failure, outputs: failure });
    expect(await screen.findByText('Some agent information is unavailable')).toBeTruthy();
    expect(screen.getByText('running', { selector: 'span' })).toBeTruthy();
    expect(screen.getAllByText('Activity unavailable.')).toHaveLength(2);
    expect(screen.queryByText('No saved output recorded.')).toBeNull();
  });

  it('refreshes on workspace hints, ignores foreign hints and closes its subscription', async () => {
    let finished = false;
    const { transport, unmount } = mount({ agents: () => response({ attempts: [finished
      ? { ...attempt, status: 'completed', endedAt: timestamp, assignments: [{ ...attempt.assignments[0]!, status: 'completed' }] }
      : attempt] }) });
    await screen.findByText('running', { selector: 'span' });
    const before = transport.mock.calls.length;
    act(() => Source.instances[0]!.hint(uuid(900)));
    expect(transport.mock.calls.length).toBe(before);
    finished = true;
    act(() => Source.instances[0]!.hint());
    expect(await screen.findByText('Run: completed')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Active runs' })).queryByRole('article')).toBeNull();
    unmount();
    expect(Source.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it('repairs missed realtime events through polling', async () => {
    const { transport, unmount } = mount();
    await screen.findByText('running', { selector: 'span' });
    // Switch timers only after initial render, then focus to schedule a fake timer.
    vi.useFakeTimers();
    await act(async () => window.dispatchEvent(new Event('focus')));
    const before = transport.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(transport.mock.calls.length).toBeGreaterThan(before);
    unmount();
  });

  it('clears displayed agent information when workspace reads lose access', async () => {
    let missing = false;
    mount({ tasks: () => missing ? response({ error: { code: 'WORKSPACE_NOT_FOUND' } }, 404) : response({ tasks: [task] }) });
    await screen.findByText('running', { selector: 'span' });
    missing = true;
    act(() => Source.instances[0]!.hint());
    expect(await screen.findByText('Could not load agents')).toBeTruthy();
    expect(screen.queryByText('running', { selector: 'span' })).toBeNull();
  });
});

it('associates question answers and checkpoints with the exact run and agent', () => {
  const agent = attempt.assignments[0]!;
  const events = [event(1, { type: 'agent.waiting', payload: { agentId, questionId: uuid(20) } }),
    event(2, { type: 'agent.question_answered', payload: { questionId: uuid(20) } }),
    event(3, { payload: { agentId: oldAgentId } }), event(4, { runId: oldRunId }),
    event(5, { type: 'agent.checkpointed', payload: { agentId, changedPaths: ['docs/notes.md', 'outside.md', 42] } })];
  const own = eventsForAgent(events, agent);
  expect(own.map((item) => item.id)).toEqual(['1', '2', '5']);
  expect(agentOutputPaths(agent, own, [{ runId: oldRunId, agentInstanceId: oldAgentId, path: 'wrong.md', commitSha: 'a'.repeat(40) }]))
    .toEqual([{ path: 'docs/notes.md', kind: 'Checkpoint' }]);
});

it('loads all task pages and rejects foreign workspace rows at the API boundary', async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ ...task, id: uuid(i + 100) }));
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ tasks: page }))
    .mockResolvedValueOnce(response({ tasks: [{ ...task, id: uuid(200) }] }));
  const api = new WorkspaceApi(new BrowserSession(), transport);
  expect(await api.listAllTasks(id)).toHaveLength(101);
  expect(String(transport.mock.calls[1]![0])).toContain(`afterId=${uuid(199)}`);
  transport.mockResolvedValueOnce(response({ tasks: [{ ...task, workspaceId: uuid(999) }] }));
  await expect(api.listAllTasks(id)).rejects.toThrow('Invalid workspace task page');
});

it('labels the task detail return link with the Agents destination', () => {
  render(<MemoryRouter><TaskDetail task={initialTasks[0]!} base={`/w/${id}`} options={[]}
    backTo={`/w/${id}/agents`} backLabel="Back to agents" renderTab={() => null} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Back to agents' }).getAttribute('href')).toBe(`/w/${id}/agents`);
  expect(screen.queryByRole('link', { name: 'Back to history' })).toBeNull();
});
