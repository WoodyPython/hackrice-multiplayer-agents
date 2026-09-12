import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { type TaskDetail as Task } from "@app/contracts";
import { statusPresentation } from "../board";
import { inputLabel, type TaskInputOption } from "../task-inputs";

export const tabs = ["Discussion", "Drafts", "Agents", "Changes"] as const;
export type TaskTab = (typeof tabs)[number];

/**
 * Task detail layout (design §4.2).
 *
 * Presentational on purpose: it owns the header, the requirements panel, and
 * the tab strip, and the caller supplies both the primary action and each tab's
 * body. That is what lets the live page and the fixture demo render the same
 * screen without the demo's shapes leaking into the live one — the previous
 * version imported `inputOptions` from `fixtures.ts`, so the live task detail
 * would have labelled real inputs against three invented IDs.
 *
 * Discussion is the default tab, per §4.2: "Before start, Discussion is the
 * default tab."
 */
export function TaskDetail({
  task,
  base,
  options,
  action,
  banner,
  renderTab,
  onEditRequirements,
}: {
  task: Task;
  base: string;
  options: TaskInputOption[];
  action?: ReactNode;
  /** Run-level explanation (§4.7), shown above the panels rather than in a tab. */
  banner?: ReactNode;
  renderTab: (tab: TaskTab) => ReactNode;
  onEditRequirements?: () => void;
}) {
  const [tab, setTab] = useState<TaskTab>("Discussion");
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
            {task.kind === "manual_edit" && " · Manual edit"}
          </p>
        </div>
        {action}
      </header>
      {banner}
      <div className="detail-grid">
        <section className="panel requirements">
          <div className="section-heading">
            <span className="eyebrow">The brief</span>
            <h2>Requirements</h2>
          </div>
          {onEditRequirements && (
            <button type="button" onClick={onEditRequirements}>
              Edit requirements
            </button>
          )}
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
                <li key={input.id}>▤ {inputLabel(input, options)}</li>
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
            {renderTab(tab)}
          </div>
        </section>
      </div>
    </>
  );
}
