import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DiscussionEntry, TaskEvent } from '@app/contracts';
import { readDiscussionPages, readEventPages } from './task-polling';
import type { WorkspaceApi } from './workspace-api';
import { RequirementForm } from './components/RequirementForm';
import { RunOutcome } from './components/RunOutcome';

const event = (id: string, runId = 'old', reason = 'snapshot_conflict') => ({ id, taskId: "task", createdAt: "2026-09-12T10:00:00Z", runId, type: 'agent.waiting', payload: { phase: 'start', reason } }) as TaskEvent;
const entry = (seq: number, status = 'open') => ({ id: String(seq), seq, question: { status } }) as DiscussionEntry;

it('drains event pages from the last returned ID and retains history across failed pulls', async () => {
  const previous = [event('1')];
  const listTaskEvents = vi.fn().mockResolvedValueOnce({ events: [event('2')], latestId: '3' })
    .mockResolvedValueOnce({ events: [event('3')], latestId: '3' });
  const api = { listTaskEvents } as unknown as WorkspaceApi;
  const result = await readEventPages(api, 'w', 't', previous, new AbortController().signal);
  expect(result.map((row) => row.id)).toEqual(['1', '2', '3']);
  expect(listTaskEvents.mock.calls.map((call) => call[2])).toEqual(['1', '2']);
  listTaskEvents.mockResolvedValueOnce({ events: [event('4')], latestId: '5' }).mockRejectedValueOnce(new Error('offline'));
  await expect(readEventPages(api, 'w', 't', result, new AbortController().signal)).rejects.toThrow('offline');
  expect(result.map((row) => row.id)).toEqual(['1', '2', '3']);
});

it('rescans paginated mutable questions without mutating the last good thread on failure', async () => {
  const listDiscussion = vi.fn().mockResolvedValueOnce({ entries: [entry(1)], latestSeq: 2, activeRunCutoffSeq: 1 })
    .mockResolvedValueOnce({ entries: [entry(2)], latestSeq: 2, activeRunCutoffSeq: 1 });
  const api = { listDiscussion } as unknown as WorkspaceApi;
  const old = await readDiscussionPages(api, 'w', 't', new AbortController().signal);
  listDiscussion.mockResolvedValueOnce({ entries: [entry(1, 'answered')], latestSeq: 2, activeRunCutoffSeq: null })
    .mockResolvedValueOnce({ entries: [entry(2, 'expired')], latestSeq: 2, activeRunCutoffSeq: null });
  const fresh = await readDiscussionPages(api, 'w', 't', new AbortController().signal);
  expect(listDiscussion.mock.calls.map((call) => call[2])).toEqual([0, 1, 0, 1]);
  expect(fresh.entries.map((row) => row.question?.status)).toEqual(['answered', 'expired']);
  expect(fresh.activeRunCutoffSeq).toBeNull();
  listDiscussion.mockResolvedValueOnce({ entries: [entry(1)], latestSeq: 2 }).mockRejectedValueOnce(new Error('offline'));
  await expect(readDiscussionPages(api, 'w', 't', new AbortController().signal)).rejects.toThrow();
  expect(old.entries.map((row) => row.question?.status)).toEqual(['open', 'open']);
});

it('keeps unavailable selected inputs until explicitly removed', () => {
  const onSubmit = vi.fn();
  const form = render(<RequirementForm options={[]} initial={{ title: 'Keep context', inputs: [{ approvedPath: 'documents/old.md', sourceVersion: 'pinned-sha' }] }} onSubmit={onSubmit} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Post task' }));
  expect(onSubmit.mock.calls[0]![0].inputs).toEqual([{ approvedPath: 'documents/old.md', sourceVersion: 'pinned-sha' }]);
  form.rerender(<RequirementForm options={[{ label: 'Now listed', category: 'Approved file', value: { approvedPath: 'documents/old.md' } }]} onSubmit={onSubmit} onCancel={() => {}} />);
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Post task' }));
  expect(onSubmit.mock.calls[1]![0].inputs).toEqual([]);
});

it('does not describe a successful reused-plan retry as the old attempt failure', () => {
  render(<RunOutcome status="ready_for_review" runId="new" events={[event('1'), event('2', 'new', 'retry_plan_reused')]} />);
  expect(screen.queryByRole('status')).toBeNull();
});
