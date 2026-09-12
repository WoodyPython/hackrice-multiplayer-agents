import type { TaskSummary } from '@app/contracts';
import { Inbox } from 'lucide-react';
import { BOARD_COLUMNS, groupTasksByColumn } from '../lib/taskBoard.js';
import { TaskCard } from './TaskCard.js';

export function TaskBoard({ tasks }: { tasks: readonly TaskSummary[] }) {
  const grouped = groupTasksByColumn(tasks);

  return (
    <div className="board" aria-label="Task board">
      {BOARD_COLUMNS.map((column) => (
        <section className="board-column" key={column.id}>
          <header className="column-header">
            <div>
              <h2>{column.label}</h2>
              <span className={`column-dot dot-${column.id}`} />
              <span className="column-count">{grouped[column.id].length}</span>
            </div>
            <p>{column.description}</p>
          </header>
          <div className="column-cards">
            {grouped[column.id].map((task) => <TaskCard key={task.id} task={task} />)}
            {grouped[column.id].length === 0 && (
              <div className="column-empty"><Inbox size={18} /><span>No tasks here</span></div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
