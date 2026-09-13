/**
 * Save text the browser already has to a file on disk.
 *
 * No request: both callers are looking at content that has already been
 * fetched, or is live in the editor, so a download endpoint would only fetch it
 * a second time and have to re-authorize to do it.
 *
 * `Content-Disposition` is the usual way to name a downloaded file; this is the
 * client-side equivalent, an anchor with `download` clicked programmatically.
 * The object URL is revoked on the next tick rather than immediately, because
 * some browsers have not finished reading it when `click()` returns.
 */
export function downloadText(path: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filenameFor(path);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Workspace paths are folder-shaped (`documents/notes.md`) and a download names
 * one file, so this takes the last segment and drops anything a filesystem
 * would refuse. The filename is a place on the reader's disk, not ours.
 */
export function filenameFor(path: string): string {
  const last = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const safe = last
    // Only what a filesystem actually refuses. Spaces and hyphens are legal in
    // a filename and belong to the author, so they stay.
    //
    // Written as an explicit list because the tidy-looking `[ -<>:"|?*]` is a
    // range, space-to-"<", and silently eats every digit and full stop:
    // `report-2026.md` came out as `report2026md`. Twice now.
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "")
    // A leading dot would save the file hidden.
    .replace(/^\.+/, "");
  return safe || "download.txt";
}
