import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AgentHistoryDetail, AgentHistoryEntry, TaskAttempt, TaskSummary } from '@app/contracts';
import { App } from './App';
import { BrowserSession } from './session';
import { WorkspaceApi } from './workspace-api';
import { workspace } from './fixtures';
import { describeToolCall } from './components/AgentHistory';
import { stubAuthApi } from './test-auth';

const id = workspace.id;
const uuid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskId = uuid(1), runId = uuid(2), agentId = uuid(3), failedId = uuid(4);
const timestamp = '2026-09-13T10:00:00Z';
const path = 'documents/guide.md';

const entry: AgentHistoryEntry = { agentInstanceId: agentId, taskId, taskTitle: 'Write the guide', runId, attempt: 1,
  assignmentKey: 'write-guide', preset: 'writer', status: 'completed', instructionSummary: 'Rewrite the guide.',
  writePaths: [path], startedAt: timestamp, endedAt: timestamp, summary: 'Rewrote the guide.', stepCount: 4 };
const failed: AgentHistoryEntry = { ...entry, agentInstanceId: failedId, assignmentKey: 'check-guide', preset: 'reviewer',
  status: 'failed', writePaths: [], summary: null, stepCount: 0 };
const detail: AgentHistoryDetail = {
  agent: entry,
  limitations: ['Not checked by a person.'],
  failureCode: null,
  steps: [
    { kind: 'model_turn', id: '1', createdAt: timestamp, thoughts: 'I should read the current guide first.', text: null,
      toolCalls: [{ name: 'read_file', arguments: { path, source: 'worker' } }], finishReason: 'STOP' },
    { kind: 'tool_results', id: '2', createdAt: timestamp,
      results: [{ name: 'read_file', outcome: 'ok', errorCode: null, detail: {} }] },
    { kind: 'model_turn', id: '3', createdAt: timestamp, thoughts: 'Now replace it.', text: null,
      toolCalls: [{ name: 'propose_changes', arguments: { changes: [{ path, expectedHash: null, newText: 'x' }] } }], finishReason: 'STOP' },
    { kind: 'tool_results', id: '4', createdAt: timestamp,
      results: [{ name: 'propose_changes', outcome: 'error', errorCode: 'FILE_VERSION_CHANGED', detail: {} }] },
  ],
  changes: { available: true, changedFiles: [{ path, changeKind: 'modified', beforeHash: 'a'.repeat(40), afterHash: 'b'.repeat(40),
    diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-Original source\n+A clearer guide.\n` }] },
};
const failedDetail: AgentHistoryDetail = { ...detail, agent: failed, limitations: [], failureCode: 'blocked_response', steps: [],
  changes: { available: false, changedFiles: [] } };

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

class Source extends EventTarget { close = vi.fn(); constructor(readonly url: string) { super(); } }

function mount(url: string, options: { agents?: AgentHistoryEntry[] } = {}) {
  const transport = vi.fn<typeof fetch>(async (input) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    if (pathname === `/api/workspaces/${id}`) return response({ ...workspace, isOwner: false });
    if (pathname === `/api/workspaces/${id}/history`) return response({ entries: [] });
    if (pathname === `/api/workspaces/${id}/agent-history`) return response({ agents: options.agents ?? [entry, failed] });
    if (pathname === `/api/workspaces/${id}/agent-history/${agentId}`) return response(detail);
    if (pathname === `/api/workspaces/${id}/agent-history/${failedId}`) return response(failedDetail);
    if (pathname === `/api/workspaces/${id}/tasks`) return response({ tasks: [] });
    return response({}, 404);
  });
  const session = new BrowserSession();
  render(<MemoryRouter initialEntries={[url]}><App session={session} api={new WorkspaceApi(session, transport)} authApi={stubAuthApi()} /></MemoryRouter>);
  const calls = (suffix: string) => transport.mock.calls.filter(([input]) => String(input).endsWith(suffix)).length;
  return { transport, calls };
}

beforeEach(() => { localStorage.clear(); vi.stubGlobal('EventSource', Source); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('History → Agent work', () => {
  it('switches from applied changes to finished agents, reading details only when opened', async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/w/${id}/history`);
    expect(await screen.findByText('Nothing has been applied yet')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Agent work' }));

    const card = await screen.findByRole('listitem', { name: 'write-guide on Write the guide' });
    expect(within(card).getByText('Rewrote the guide.')).toBeTruthy();
    expect(within(card).getByText('4 recorded steps')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Write the guide' }).getAttribute('href'))
      .toBe(`/w/${id}/tasks/${taskId}?tab=Agents&from=agent-history`);
    expect(screen.getByRole('tab', { name: 'Agent work' }).getAttribute('aria-selected')).toBe('true');
    expect(calls(`/agent-history/${agentId}`)).toBe(0);

    await user.click(within(card).getByText('Thought process and changes'));
    expect(await within(card).findByText('I should read the current guide first.')).toBeTruthy();
    expect(within(card).getByText(`Read ${path} (working copy)`)).toBeTruthy();
    expect(within(card).getByText('Reading the file succeeded')).toBeTruthy();
    expect(within(card).getByText('Saving the changes was refused: the file had changed since it was read')).toBeTruthy();
    expect(within(card).getByText('Not checked by a person.')).toBeTruthy();
    expect(within(card).getByText(/generated and has not been checked/)).toBeTruthy();
    expect(within(card).getByText('1 changed file')).toBeTruthy();
    // The diff reuses the task workflow's diff view, which splits a changed line into word spans.
    expect(within(card).getByText('1 line added, 1 line removed.')).toBeTruthy();
    expect(card.textContent).toContain('A clearer guide.');
    expect(calls(`/agent-history/${agentId}`)).toBe(1);
  });

  it('opens the agent named in the link and explains a failure without claiming no changes', async () => {
    mount(`/w/${id}/history?view=agents&agent=${failedId}`);
    const card = await screen.findByRole('listitem', { name: 'check-guide on Write the guide' });
    expect(await within(card).findByText('This agent failed')).toBeTruthy();
    expect(within(card).getByText(/model declined to respond/)).toBeTruthy();
    expect(within(card).getByText('No thought process was recorded for this agent.')).toBeTruthy();
    expect(within(card).getByText('This agent’s changes could not be read from the workspace history.')).toBeTruthy();
    // The other agent stays closed.
    const other = screen.getByRole('listitem', { name: 'write-guide on Write the guide' });
    expect(within(other).queryByText('I should read the current guide first.')).toBeNull();
  });

  it('shows an honest empty state', async () => {
    mount(`/w/${id}/history?view=agents`, { agents: [] });
    expect(await screen.findByText('No finished agents yet')).toBeTruthy();
  });
});

it('links finished agents on the Agents page to their history', async () => {
  const task: TaskSummary = { id: taskId, workspaceId: id, kind: 'agent_task', title: 'Write the guide', outcome: '', criteria: [],
    version: 1, status: 'completed', creatorGuestLabel: 'Guest', activeRunId: null, materialCount: 0, discussionCount: 0,
    openQuestionCount: 0, updatedAt: timestamp };
  const attempt: TaskAttempt = { runId, attempt: 1, status: 'completed', taskVersion: 1, createdAt: timestamp, endedAt: timestamp,
    assignments: [{ id: agentId, runId, taskId, agentKey: 'writer', assignmentKey: 'write-guide', preset: 'writer', status: 'completed',
      instructionSummary: 'Rewrite the guide.', writePaths: [path], dependsOn: [], baseSha: null, resultSha: null,
      startedAt: timestamp, deadlineAt: timestamp, endedAt: timestamp }] };
  const transport = vi.fn<typeof fetch>(async (input) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    if (pathname === `/api/workspaces/${id}`) return response({ ...workspace, isOwner: false });
    if (pathname === `/api/workspaces/${id}/tasks`) return response({ tasks: [task] });
    if (pathname.endsWith('/agents')) return response({ attempts: [attempt] });
    if (pathname.endsWith('/events')) return response({ events: [], latestId: null });
    if (pathname.endsWith('/saved-outputs')) return response({ outputs: [] });
    return response({}, 404);
  });
  const session = new BrowserSession();
  render(<MemoryRouter initialEntries={[`/w/${id}/agents`]}><App session={session} api={new WorkspaceApi(session, transport)} authApi={stubAuthApi()} /></MemoryRouter>);
  const link = await screen.findByRole('link', { name: 'View thought process and changes' });
  expect(link.getAttribute('href')).toBe(`/w/${id}/history?view=agents&agent=${agentId}`);
});

it('describes tool calls in words and tolerates clipped or missing arguments', () => {
  expect(describeToolCall({ name: 'read_file', arguments: { path, source: 'approved' } })).toBe(`Read ${path} (approved)`);
  expect(describeToolCall({ name: 'propose_changes', arguments: { changes: [{ path }, { path: 'code/a.ts' }] } }))
    .toBe(`Proposed changes to ${path}, code/a.ts`);
  expect(describeToolCall({ name: 'propose_changes', arguments: { changes: '…' } })).toBe('Proposed changes');
  expect(describeToolCall({ name: 'ask_question', arguments: { body: 'Which region?' } })).toBe('Asked: “Which region?”');
  expect(describeToolCall({ name: 'something_new', arguments: {} })).toBe('Used something_new');
});
