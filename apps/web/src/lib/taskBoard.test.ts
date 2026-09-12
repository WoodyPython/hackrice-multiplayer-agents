import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, type TaskSummary } from '@app/contracts';
import { columnForStatus, groupTasksByColumn } from './taskBoard.js';

describe('task board placement', () => {
  it('places every contract task state into exactly one board column', () => {
    expect(TASK_STATUSES.map(columnForStatus)).toEqual([
      'posted',
      'working',
      'working',
      'attention',
      'review',
      'attention',
      'attention',
      'attention',
      'completed',
      'completed',
    ]);
  });

  it('preserves each task once when grouping', () => {
    const task = {
      id: 'c209529d-61be-4779-9d67-c2257be14023',
      workspaceId: '58bb9109-ad24-45ac-8f84-169226b03e69',
      kind: 'agent_task',
      title: 'Example',
      outcome: '',
      criteria: [],
      version: 1,
      status: 'posted',
      creatorGuestLabel: 'Guest Cedar',
      activeRunId: null,
      materialCount: 0,
      openQuestionCount: 0,
      updatedAt: '2026-09-12T13:28:00-05:00',
    } satisfies TaskSummary;

    const grouped = groupTasksByColumn([task]);
    expect(Object.values(grouped).flat()).toEqual([task]);
  });
});
