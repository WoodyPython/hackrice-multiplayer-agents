import { useState, type FormEvent } from "react";
import { postTaskRequestSchema } from "@app/contracts";
import { inputIdentity, type TaskInputOption } from "../task-inputs";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Checkbox,
  FieldError,
  FieldHint,
  Input,
  Label,
  Textarea,
} from "./ui/field";
import { Eyebrow } from "./ui/misc";

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
  const [selected, setSelected] = useState<TaskInputOption["value"][]>(
    () => initial?.inputs ?? [],
  );
  const identity = inputIdentity;
  const choices = [
    ...options,
    ...selected
      .filter(
        (value) =>
          !options.some((option) => identity(option.value) === identity(value)),
      )
      .map((value) => ({
        value,
        category: "Selected input (no longer listed)",
        label:
          "approvedPath" in value
            ? value.approvedPath
            : "materialId" in value
              ? value.materialId
              : value.draftFileId,
      })),
  ];

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
      inputs: selected,
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
    <form
      className="max-w-3xl overflow-hidden rounded-xl border border-border bg-card shadow-xs"
      onSubmit={submit}
      noValidate
    >
      <div className="border-b border-border bg-muted/30 p-6">
        <Eyebrow>{heading?.eyebrow ?? "01 / Define the work"}</Eyebrow>
        <h2 className="mt-2 text-[19px] font-semibold tracking-[-0.025em]">
          {heading?.title ?? "A little clarity goes a long way."}
        </h2>
        <p className="mt-1.5 max-w-lg text-[13px] text-muted-foreground">
          {heading?.blurb ??
            "Describe the outcome. You can discuss it together before starting any agents."}
        </p>
      </div>

      <div className="space-y-5 p-6">
        {(Object.keys(errors).length > 0 || error) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[13px] text-destructive"
          >
            {error ?? "Check the highlighted fields before posting."}
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="title">
            Task title
            <FieldHint>Required</FieldHint>
          </Label>
          <Input
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
            <FieldError id="title-error">{errors.title}</FieldError>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="outcome">Desired outcome</Label>
          <Textarea
            id="outcome"
            name="outcome"
            rows={3}
            maxLength={10000}
            defaultValue={initial?.outcome ?? ""}
            placeholder="What should be different when this is done?"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="criteria">Acceptance criteria</Label>
          <Textarea
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
          <small
            id="criteria-hint"
            className={cn(
              "block text-[11.5px]",
              errors.criteria ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {errors.criteria ??
              "One criterion per line. These guide the review."}
          </small>
        </div>

        <fieldset className="space-y-2.5">
          <legend className="text-[13px] font-medium text-foreground/90">
            Selected inputs
          </legend>
          <p className="text-[12px] text-muted-foreground">
            Give the task the context it needs.
          </p>
          {choices.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3.5 py-4 text-[12.5px] text-muted-foreground">
              Nothing to select yet. Upload a reference material, or open a file
              with Edit together, and it will appear here.
            </p>
          ) : (
            <div className="grid gap-1.5">
              {choices.map((option) => {
                const checked = selected.some(
                  (value) => identity(value) === identity(option.value),
                );
                return (
                  <label
                    key={identity(option.value)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 transition-colors",
                      checked
                        ? "border-navy-300 bg-navy-50/70 dark:border-navy-700 dark:bg-navy-950/50"
                        : "border-border hover:bg-muted/60",
                    )}
                  >
                    <Checkbox
                      name="inputs"
                      checked={checked}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, option.value]
                            : current.filter(
                                (value) =>
                                  identity(value) !== identity(option.value),
                              ),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">
                        {option.label}
                      </span>
                      <small className="block text-[11px] text-muted-foreground">
                        {option.category}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {optionsNote && (
            <small className="block text-[11.5px] text-muted-foreground">
              {optionsNote}
            </small>
          )}
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor="outputPaths">
            Intended output paths
            <FieldHint>Optional</FieldHint>
          </Label>
          <Textarea
            id="outputPaths"
            name="outputPaths"
            rows={2}
            defaultValue={(initial?.outputPaths ?? []).join("\n")}
            placeholder="documents/launch.md"
            aria-invalid={!!errors.outputPaths}
            aria-describedby="paths-hint"
            className="font-mono text-[12.5px]"
          />
          <small
            id="paths-hint"
            className={cn(
              "block text-[11.5px]",
              errors.outputPaths ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {errors.outputPaths ?? "One repository-relative path per line."}
          </small>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border bg-muted/30 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11.5px] text-muted-foreground">
          Posting opens discussion. Agents stay idle.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} disabled={pending} variant="ghost">
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
