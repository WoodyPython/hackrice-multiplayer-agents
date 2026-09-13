import { describe, expect, it, vi } from "vitest";
import { downloadText, filenameFor } from "./lib/download";

/**
 * Saving a draft or an approved file to disk.
 *
 * The filename half is worth testing on its own: the first version of the
 * sanitiser used `[ -<>:"|?*]`, which reads like a tidy set of punctuation and
 * is really the range space-to-`<` — so it silently ate every digit and full
 * stop, turning `notes.md` into `notesmd` and `report-2026.txt` into
 * `report2026txt`. Nothing about that is visible by inspection.
 */

describe("filenameFor", () => {
  it("takes the last segment and keeps the extension", () => {
    expect(filenameFor("documents/notes.md")).toBe("notes.md");
    expect(filenameFor("a/b/c/deep.txt")).toBe("deep.txt");
    expect(filenameFor("top.md")).toBe("top.md");
  });

  it("keeps digits and dots, which a character range would have eaten", () => {
    expect(filenameFor("documents/report-2026.final.txt")).toBe("report-2026.final.txt");
    expect(filenameFor("2026.md")).toBe("2026.md");
  });

  it("refuses to write outside the folder the reader chose", () => {
    // The path is ours; the filename is a place on their disk. Separators and
    // traversal must not survive into it.
    expect(filenameFor("../../etc/passwd")).toBe("passwd");
    expect(filenameFor("documents\\windows\\notes.md")).toBe("notes.md");
    expect(filenameFor("../..")).toBe("download.txt");
  });

  it("never returns something a filesystem would refuse", () => {
    expect(filenameFor('weird:"name"<>|?*.md')).toBe("weirdname.md");
    // Spaces and hyphens are legal and are the author's choice, not ours.
    expect(filenameFor("launch brief-v2.md")).toBe("launch brief-v2.md");
    expect(filenameFor(".hidden")).toBe("hidden");
    expect(filenameFor("")).toBe("download.txt");
    expect(filenameFor("///")).toBe("download.txt");
  });
});

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("downloadText", () => {
  it("hands the browser the exact text under the file's own name", async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:stub";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      downloadText("documents/notes.md", "Hello from the shared draft.");
      expect(click).toHaveBeenCalledOnce();
      const anchor = click.mock.contexts[0] as HTMLAnchorElement;
      expect(anchor.download).toBe("notes.md");
      expect(blobs).toHaveLength(1);
      expect(blobs[0]!.type).toBe("text/plain;charset=utf-8");
      // jsdom's Blob implements neither `text()` nor streaming into Response,
      // so read it with the one API it does support.
      expect(await readBlob(blobs[0]!)).toBe("Hello from the shared draft.");
      // The anchor is a means, not a leak: it must not be left in the document.
      expect(document.querySelector("a[download]")).toBeNull();
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("releases the object URL, so a long session does not leak blobs", async () => {
    vi.useFakeTimers();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:stub", revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    try {
      downloadText("a.md", "x");
      // Deliberately not revoked synchronously: some browsers have not finished
      // reading the blob when `click()` returns.
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub");
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
