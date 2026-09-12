import { useState, type FormEvent } from "react";
import { postTaskRequestSchema, type PostTaskRequest } from "@app/contracts";
import { inputOptions } from "../fixtures";

export function RequirementForm({
  onPost,
  onCancel,
  guestLabel = "Guest Maple",
}: {
  onPost: (request: PostTaskRequest) => void;
  onCancel: () => void;
  guestLabel?: string;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines = (key: string) =>
      String(data.get(key) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const parsed = postTaskRequestSchema.safeParse({
      title: data.get("title"),
      outcome: data.get("outcome"),
      criteria: lines("criteria"),
      outputPaths: lines("outputPaths"),
      creatorGuestLabel: guestLabel,
      inputs: data
        .getAll("inputs")
        .map((index) => inputOptions[Number(index)]!.value),
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
    onPost(parsed.data);
  }
  return (
    <form className="panel requirement-form" onSubmit={submit} noValidate>
      <div className="section-heading">
        <span className="eyebrow">01 / Define the work</span>
        <h2>A little clarity goes a long way.</h2>
        <p>
          Describe the outcome. You can discuss it together before starting any
          agents.
        </p>
      </div>
      {Object.keys(errors).length > 0 && (
        <p role="alert" className="error">
          Check the highlighted fields before posting.
        </p>
      )}
      <label htmlFor="title">
        Task title <span className="required">Required</span>
      </label>
      <input
        id="title"
        name="title"
        autoFocus
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
        placeholder="What should be different when this is done?"
      />
      <label htmlFor="criteria">Acceptance criteria</label>
      <textarea
        id="criteria"
        name="criteria"
        rows={3}
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
        {inputOptions.map((option, index) => (
          <label className="input-option" key={option.label}>
            <input type="checkbox" name="inputs" value={index} />
            <span>
              {option.label}
              <small>{option.category}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label htmlFor="outputPaths">
        Intended output paths <span className="required">Optional</span>
      </label>
      <textarea
        id="outputPaths"
        name="outputPaths"
        rows={2}
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
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" type="submit">
            Post task
          </button>
        </div>
      </div>
    </form>
  );
}
