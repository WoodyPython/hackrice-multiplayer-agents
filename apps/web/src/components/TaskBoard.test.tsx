// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { fixtureTasks } from '../fixtures/tasks.js';
import { TaskBoard } from './TaskBoard.js';

describe('TaskBoard', () => {
  it('renders the five lifecycle columns and contract-shaped fixture cards', () => {
    render(
      <MemoryRouter>
        <TaskBoard tasks={fixtureTasks} />
      </MemoryRouter>,
    );

    for (const heading of ['Posted', 'Working', 'Needs attention', 'Review', 'Completed']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Draft the judging FAQ' })).toBeInTheDocument();
    expect(screen.getByText('Answer needed')).toBeInTheDocument();
    expect(screen.getByText('Ready for review')).toBeInTheDocument();
  });
});
