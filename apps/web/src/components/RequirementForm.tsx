import { useState, type FormEvent } from "react";
import { postTaskRequestSchema } from "@app/contracts";
import type { TaskInputOption } from "../task-inputs";

/** The fields §2.1 puts on the form, shared by posting and revising. */
export type TaskFields = {
  title: string;
  outcome: string;
  criteria: string[];
  outputPaths: string[];
  inputs: TaskInputOption["value"][];
};

/**
 * The requirements form (design §2.1), used both to post a task and to revise
 * one.
 *
 * One form for both because the field set is identical and the difference is
 * entirely in the caller: posting sends `creatorGuestLabel`, revising sends
 * `expectedVersion`. Splitting them produced two copies of the same validation
 * in the fixture version of this file.
 *
 * `options` arrives as a prop rather than being imported. It used to come from
 * `fixtures.ts`, which meant the live form offered three hardcoded material IDs
 * that did not exist in any real workspace.
 */
export function RequirementForm({
  options,
  optionsNote,
  onSubmit,
  onCancel,
  guestLabel = "Guest",
  initial,
  pending = false,
  error = null,
  submitLabel = "Post task",
  heading,
}: {
  options: TaskInputOption[];
  optionsNote?: string;
  onSubmit: (fields: TaskFields) => void;
  onCancel: () => void;
  guestLabel?: string;
  initial?: Partial<TaskFields>;
  pending?: boolean;
  error?: string | null;
  submitLabel?: string;
  heading?: { eyebrow: string; title: string; blurb: string };
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<number[]>(() =>
    options.flatMap((option, index) =>
      (initial?.inputs ?? []).some(
        (value) => JSON.stringify(value) === JSON.stringify(option.value),
      )
        ? [index]
        : [],
    ),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines = (key: string) =>
      String(data.get(key) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const fields = {
      title: String(data.get("title") ?? ""),
      outcome: String(data.get("outcome") ?? ""),
      criteria: lines("criteria"),
      outputPaths: lines("outputPaths"),
      inputs: selected.map((index) => options[index]!.value),
    };
    // Validate against the post schema in both modes: it carries every field
    // constraint, and field-level errors are what the form needs to render.
    const parsed = postTaskRequestSchema.safeParse({
      ...fields,
      creatorGuestLabel: guestLabel,
      clientRequestId: crypto.randomUUID(),
    });
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0] ?? "form"),
            issue.message,
          ]),
        ),
      );
      return;
    }
    setErrors({});
    onSubmit({
      title: parsed.data.title,
      outcome: parsed.data.outcome,
      criteria: parsed.data.criteria,
      outputPaths: parsed.data.outputPaths,
      inputs: fields.inputs,
    });
  }

  return (
    <form className="panel requirement-form" onSubmit={submit} noValidate>
      <div className="section-heading">
        <span className="eyebrow">
          {heading?.eyebrow ?? "01 / Define the work"}
        </span>
        <h2>{heading?.title ?? "A little clarity goes a long way."}</h2>
        <p>
          {heading?.blurb ??
            "Describe the outcome. You can discuss it together before starting any agents."}
        </p>
      </div>
      {(Object.keys(errors).length > 0 || error) && (
        <p role="alert" className="error">
          {error ?? "Check the highlighted fields before posting."}
        </p>
      )}
      <label htmlFor="title">
        Task title <span className="required">Required</span>
      </label>
      <input
        id="title"
        name="title"
        autoFocus
        defaultValue={initial?.title ?? ""}
        placeholder="What would you like to get done?"
        maxLength={200}
        aria-invalid={!!errors.title}
        aria-describedby={errors.title ? "title-error" : undefined}
      />
      {errors.title && (
        <small id="title-error" className="error">
          {errors.title}
        </small>
      )}
      <label htmlFor="outcome">Desired outcome</label>
      <textarea
        id="outcome"
        name="outcome"
        rows={3}
        maxLength={10000}
        defaultValue={initial?.outcome ?? ""}
        placeholder="What should be different when this is done?"
      />
      <label htmlFor="criteria">Acceptance criteria</label>
      <textarea
        id="criteria"
        name="criteria"
        rows={3}
        defaultValue={(initial?.criteria ?? []).join("\n")}
        placeholder={
          "One criterion per line\nExample: Include a clear next step"
        }
        aria-invalid={!!errors.criteria}
        aria-describedby="criteria-hint"
      />
      <small id="criteria-hint" className={errors.criteria ? "error" : ""}>
        {errors.criteria ?? "One criterion per line. These guide the review."}
      </small>
      <fieldset>
        <legend>Selected inputs</legend>
        <p className="muted">Give the task the context it needs.</p>
        {options.length === 0 ? (
          <p className="muted">
            Nothing to select yet. Upload a reference material, or open a file
            with Edit together, and it will appear here.
          </p>
        ) : (
          options.map((option, index) => (
            <label className="input-option" key={`${option.category}:${option.label}`}>
              <input
                type="checkbox"
                name="inputs"
                checked={selected.includes(index)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, index]
                      : current.filter((value) => value !== index),
                  )
                }
              />
              <span>
                {option.label}
                <small>{option.category}</small>
              </span>
            </label>
          ))
        )}
        {optionsNote && <small className="muted">{optionsNote}</small>}
      </fieldset>
      <label htmlFor="outputPaths">
        Intended output paths <span className="required">Optional</span>
      </label>
      <textarea
        id="outputPaths"
        name="outputPaths"
        rows={2}
        defaultValue={(initial?.outputPaths ?? []).join("\n")}
        placeholder="docs/launch.md"
        aria-invalid={!!errors.outputPaths}
        aria-describedby="paths-hint"
      />
      <small id="paths-hint" className={errors.outputPaths ? "error" : ""}>
        {errors.outputPaths ?? "One repository-relative path per line."}
      </small>
      <div className="form-footer">
        <p>Posting opens discussion. Agents stay idle.</p>
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
