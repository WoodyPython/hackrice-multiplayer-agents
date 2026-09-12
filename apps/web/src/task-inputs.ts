import type { ApprovedFile, DraftFile, Material, TaskInputLink } from "@app/contracts";

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
  value: ({ materialId: string } | { draftFileId: string } | { approvedPath: string }) & { sourceVersion?: string };
};

/**
 * Build the picker's options from what the workspace actually holds.
 *
 * All three categories come from authoritative workspace reads.
 *
 * Materials come first because they are the category people arrive with; a
 * draft only exists once someone has started editing.
 */
export function inputOptionsFrom(
  materials: Material[],
  drafts: DraftFile[],
  approved: ApprovedFile[] = [],
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
    ...approved.map((file) => ({ label: file.path, category: "Approved file", value: { approvedPath: file.path } })),
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


/** Selection identity excludes the optional pinned version metadata. */
export function inputIdentity(value: TaskInputOption["value"]): string {
  return "materialId" in value ? `material:${value.materialId}`
    : "draftFileId" in value ? `draft:${value.draftFileId}` : `approved:${value.approvedPath}`;
}
