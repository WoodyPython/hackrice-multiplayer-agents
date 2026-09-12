import { Link } from "react-router-dom";
import { TASK_STATUSES, type TaskSummary } from "@app/contracts";
import { useState } from "react";
import { groupTasks, statusPresentation } from "../board";
import { EmptyState } from "../components/EmptyState";

export function TaskBoard({
  tasks,
  base,
}: {
  tasks: TaskSummary[];
  base: string;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(query.toLowerCase()) &&
      (status === "all" || task.status === status),
  );
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">Your shared workspace</span>
          <h1>Good work starts here.</h1>
          <p>Bring an idea. Shape it together. Ship something useful.</p>
        </div>
        <Link className="button primary" to={`${base}/tasks/new`}>
          ＋ Post a task
        </Link>
      </header>
      <div className="board-toolbar">
        <div className="board-title">
          <h2>Task board</h2>
          <span className="count">{tasks.length}</span>
        </div>
        <div className="filters">
          <label className="sr-only" htmlFor="search">
            Search tasks
          </label>
          <input
            id="search"
            type="search"
            placeholder="Search tasks…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="sr-only" htmlFor="status">
            Filter by status
          </label>
          <select
            id="status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            {TASK_STATUSES.map((value) => (
              <option value={value} key={value}>
                {statusPresentation[value].label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {tasks.length === 0 ? (
        <EmptyState
          title="Make room for your first idea."
          action={
            <Link className="button primary" to={`${base}/tasks/new`}>
              Post a task
            </Link>
          }
        >
          Describe a small piece of work to begin. You can discuss the details
          before starting.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No matching tasks"
          action={
            <button
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
            >
              Clear filters
            </button>
          }
        >
          Try a different title or status.
        </EmptyState>
      ) : (
        <div className="board">
          {groupTasks(filtered).map((column) => (
            <section
              className="board-column"
              key={column.name}
              aria-label={column.name}
            >
              <h3>
                <span
                  className={`column-dot dot-${column.name.split(" ")[0]!.toLowerCase()}`}
                />
                {column.name}
                <span className="column-count">{column.tasks.length}</span>
              </h3>
              <div className="card-stack">
                {column.tasks.map((task) => (
                  <Link
                    className="task-card"
                    to={`${base}/tasks/${task.id}`}
                    key={task.id}
                  >
                    <span className={`status status-${task.status}`}>
                      {statusPresentation[task.status].label}
                    </span>
                    <h4>{task.title}</h4>
                    <p>{statusPresentation[task.status].summary}</p>
                    {task.openQuestionCount > 0 && (
                      <span className="question-note">
                        {task.openQuestionCount} question needs an answer
                      </span>
                    )}
                    <div className="card-footer">
                      <span>
                        <span className="avatar" aria-hidden="true">
                          {task.creatorGuestLabel.split(" ")[1]?.[0] ?? "G"}
                        </span>
                        {task.creatorGuestLabel}
                      </span>
                      <span>
                        {task.materialCount} material
                        {task.materialCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </Link>
                ))}
                {column.tasks.length === 0 && (
                  <p className="column-empty">No tasks here yet</p>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      <p className="board-note">
        <span aria-hidden="true">↳</span> Tasks move as the work progresses.
        Every change gets a review.
      </p>
    </>
  );
}
