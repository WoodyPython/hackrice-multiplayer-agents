import { useState } from "react";
import { Link } from "react-router-dom";
import {
  STARTABLE_TASK_STATUSES,
  type TaskDetail as Task,
} from "@app/contracts";
import { statusPresentation } from "../board";
import { inputOptions } from "../fixtures";
import { EmptyState } from "../components/EmptyState";

const tabs = ["Discussion", "Drafts", "Agents", "Changes"] as const;
const emptyCopy = {
  Discussion: [
    "Start with a conversation",
    "Discuss the requirements and selected inputs before starting the task. Discussion will connect in a later ticket.",
  ],
  Drafts: [
    "A place for work in progress",
    "Shared drafts will appear here when editing is connected.",
  ],
  Agents: [
    "Assignments will appear here",
    "Agent progress is not connected in this preview. Posting a task does not start any agents.",
  ],
  Changes: [
    "Nothing to review here yet",
    "Combined changes and owner review will appear here when review is connected.",
  ],
} as const;

export function TaskDetail({ task, base }: { task: Task; base: string }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Discussion");
  const canStart =
    task.kind === "agent_task" &&
    task.activeRunId === null &&
    (STARTABLE_TASK_STATUSES as readonly string[]).includes(task.status);
  return (
    <>
      <Link className="back-link" to={base}>
        ← All tasks
      </Link>
      <header className="page-heading">
        <div>
          <span className={`status status-${task.status}`}>
            {statusPresentation[task.status].label}
          </span>
          <h1>{task.title}</h1>
          <p>
            Posted by {task.creatorGuestLabel} · Version {task.version}
          </p>
        </div>
        {canStart && (
          <div className="start-action">
            <button className="primary" disabled aria-describedby="start-help">
              Start task
            </button>
            <small id="start-help">
              Execution is not connected in this preview.
            </small>
          </div>
        )}
      </header>
      <div className="detail-grid">
        <section className="panel requirements">
          <span className="eyebrow">The brief</span>
          <h2>Requirements</h2>
          <h3>Desired outcome</h3>
          <p>{task.outcome || "No outcome added yet."}</p>
          <h3>Acceptance criteria</h3>
          {task.criteria.length ? (
            <ul className="criteria">
              {task.criteria.map((criterion, index) => (
                <li key={index}>
                  <span aria-hidden="true">□</span>
                  {criterion}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No criteria added yet.</p>
          )}
          <h3>Selected inputs</h3>
          {task.inputs.length ? (
            <ul className="file-list">
              {task.inputs.map((input) => (
                <li key={input.id}>
                  ▤{" "}
                  {inputOptions.find(
                    (option) =>
                      ("materialId" in option.value &&
                        option.value.materialId === input.materialId) ||
                      ("draftFileId" in option.value &&
                        option.value.draftFileId === input.draftFileId) ||
                      ("approvedPath" in option.value &&
                        option.value.approvedPath === input.approvedPath),
                  )?.label ??
                    input.approvedPath ??
                    "Selected input"}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No inputs selected.</p>
          )}
          <h3>Intended output paths</h3>
          {task.outputPaths.length ? (
            task.outputPaths.map((path) => (
              <code className="path" key={path}>
                {path}
              </code>
            ))
          ) : (
            <p className="muted">No output paths specified.</p>
          )}
        </section>
        <section className="panel activity">
          <div className="tabs" role="tablist" aria-label="Task activity">
            {tabs.map((name, index) => (
              <button
                key={name}
                id={`tab-${name}`}
                role="tab"
                aria-selected={tab === name}
                aria-controls="activity-panel"
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + tabs.length - 1) % tabs.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? tabs.length - 1
                            : null;
                  if (next !== null) {
                    event.preventDefault();
                    setTab(tabs[next]!);
                    document.getElementById(`tab-${tabs[next]}`)?.focus();
                  }
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="activity-panel"
            aria-labelledby={`tab-${tab}`}
            tabIndex={0}
          >
            <EmptyState title={emptyCopy[tab][0]}>
              {emptyCopy[tab][1]}
            </EmptyState>
          </div>
        </section>
      </div>
    </>
  );
}
