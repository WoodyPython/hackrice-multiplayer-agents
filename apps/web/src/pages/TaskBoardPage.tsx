import { Filter, Search, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { taskDetailSchema, type PostTaskRequest, type TaskSummary } from '@app/contracts';
import { AppShell } from '../components/AppShell.js';
import { NewTaskDialog } from '../components/NewTaskDialog.js';
import { TaskBoard } from '../components/TaskBoard.js';
import { TaskBoardSkeleton } from '../components/TaskBoardSkeleton.js';
import { DEMO_WORKSPACE_ID, fixtureTaskDetails, fixtureTasks } from '../fixtures/tasks.js';
import { useParams } from 'react-router-dom';

export function TaskBoardPage() {
  const { workspaceId = DEMO_WORKSPACE_ID } = useParams();
  const [tasks, setTasks] = useState<TaskSummary[]>(fixtureTasks);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showLoading, setShowLoading] = useState(false);

  const filteredTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => `${task.title} ${task.outcome}`.toLowerCase().includes(normalized));
  }, [query, tasks]);

  function postTask(request: PostTaskRequest) {
    const nextTask: TaskSummary = {
      id: crypto.randomUUID(),
      workspaceId,
      kind: request.kind,
      title: request.title,
      outcome: request.outcome,
      criteria: request.criteria,
      version: 1,
      status: 'posted',
      creatorGuestLabel: request.creatorGuestLabel,
      activeRunId: null,
      materialCount: request.inputs.filter((input) => input.materialId).length,
      openQuestionCount: 0,
      updatedAt: new Date().toISOString(),
    };
    fixtureTaskDetails[nextTask.id] = taskDetailSchema.parse({
      ...nextTask,
      manualSourcePath: null,
      outputPaths: request.outputPaths,
      discussionSeq: 0,
      inputs: [],
      createdAt: nextTask.updatedAt,
    });
    setTasks((current) => [nextTask, ...current]);
    setDialogOpen(false);
  }

  return (
    <AppShell onNewTask={() => setDialogOpen(true)}>
      <section className="page-heading">
        <div><span className="eyebrow">Shared task board</span><h1>Good afternoon, Cedar.</h1><p>Shape the work together, then start agents when the brief is ready.</p></div>
        <div className="heading-stat"><strong>{tasks.filter((task) => task.status === 'working' || task.status === 'planning').length}</strong><span>tasks in progress</span></div>
      </section>

      <div className="board-toolbar">
        <label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" /></label>
        <button className="filter-button"><Filter size={16} /> My tasks</button>
        <button className="filter-button"><SlidersHorizontal size={16} /> Filter</button>
        <button className="loading-preview" onClick={() => setShowLoading((current) => !current)}>{showLoading ? 'Show tasks' : 'Preview loading'}</button>
      </div>

      {showLoading ? <TaskBoardSkeleton /> : <TaskBoard tasks={filteredTasks} />}
      {!showLoading && filteredTasks.length === 0 && (
        <div className="search-empty"><Search size={24} /><h2>No matching tasks</h2><p>Try a different title or outcome.</p></div>
      )}
      <NewTaskDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSubmit={postTask} />
    </AppShell>
  );
}
