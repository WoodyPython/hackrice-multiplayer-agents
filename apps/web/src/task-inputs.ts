import type { DraftFile, Material, TaskInputLink } from "@app/contracts";

/**
 * One selectable context source for a task (design §2.1, §3.3).
 *
 * `value` is exactly the shape `taskInputSelectionSchema` accepts — one of the
 * three keys, never more — so a selected option can be handed to the API
 * without translation.
 */
export type TaskInputOption = {
  label: string;
  category: string;
  value:
    | { materialId: string }
    | { draftFileId: string }
    | { approvedPath: string };
};

/**
 * Build the picker's options from what the workspace actually holds.
 *
 * §2.1 names three categories: reference materials, approved files, and shared
 * drafts. Only two are buildable. **Approved files cannot be listed** — the Git
 * service exposes `readText(path)` for a single known path and has no tree or
 * list operation, so nothing in the system can enumerate what is on main. The
 * picker therefore offers materials and drafts, and the caller tells the user
 * plainly that approved files are not selectable yet rather than showing an
 * empty category that reads like "there are none".
 *
 * Materials come first because they are the category people arrive with; a
 * draft only exists once someone has started editing.
 */
export function inputOptionsFrom(
  materials: Material[],
  drafts: DraftFile[],
): TaskInputOption[] {
  return [
    ...materials
      .filter((material) => material.deletedAt === null)
      .map((material) => ({
        label: material.filename,
        category: "Reference material",
        value: { materialId: material.id },
      })),
    ...drafts.map((draft) => ({
      label: draft.path,
      category: "Shared draft",
      value: { draftFileId: draft.id },
    })),
  ];
}

/**
 * Display text for an input already attached to a task.
 *
 * A task outlives the lists it was built from: a material can be soft-deleted
 * and a draft's epoch can close, and the link row survives both. So this falls
 * back to the stored `approvedPath`, then to a neutral label, rather than
 * rendering `undefined` or dropping the row — the input really is still part of
 * the task's context manifest even when its source is no longer listable.
 */
export function inputLabel(
  link: TaskInputLink,
  options: TaskInputOption[],
): string {
  const match = options.find((option) =>
    "materialId" in option.value
      ? option.value.materialId === link.materialId
      : "draftFileId" in option.value
        ? option.value.draftFileId === link.draftFileId
        : option.value.approvedPath === link.approvedPath,
  );
  return match?.label ?? link.approvedPath ?? "Selected input (no longer listed)";
}

/** Matches a task's existing links back to picker options, for a pre-checked form. */
export function selectedIndexes(
  links: TaskInputLink[],
  options: TaskInputOption[],
): number[] {
  return options.flatMap((option, index) =>
    links.some((link) =>
      "materialId" in option.value
        ? option.value.materialId === link.materialId
        : "draftFileId" in option.value
          ? option.value.draftFileId === link.draftFileId
          : option.value.approvedPath === link.approvedPath,
    )
      ? [index]
      : [],
  );
}
