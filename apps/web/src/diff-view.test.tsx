import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView, parseDiff } from "./components/DiffView";

const MODIFIED = `diff --git a/documents/launch.md b/documents/launch.md
index 83db48f..bf269f4 100644
--- a/documents/launch.md
+++ b/documents/launch.md
@@ -1,4 +1,5 @@
 # Launch
-We ship on Tuesday.
+We ship on Thursday.
+Bring the checklist.

 Owner: Ada`;

describe("unified diff parsing", () => {
  it("drops the file header and numbers both sides from the hunk", () => {
    const rows = parseDiff(MODIFIED)!;
    expect(rows.some((row) => row.text.includes("83db48f"))).toBe(false);
    const added = rows.filter((row) => row.kind === "add");
    const removed = rows.filter((row) => row.kind === "del");
    expect(added.map((row) => row.text)).toEqual([
      "We ship on Thursday.",
      "Bring the checklist.",
    ]);
    expect(removed.map((row) => row.text)).toEqual(["We ship on Tuesday."]);
    // Old numbering skips the addition; new numbering skips the removal.
    expect(removed[0]!.oldLine).toBe(2);
    expect(removed[0]!.newLine).toBeUndefined();
    expect(added[0]!.newLine).toBe(2);
    expect(added[0]!.oldLine).toBeUndefined();
  });

  it("marks only the words that actually changed in a one-for-one replacement", () => {
    const rows = parseDiff(
      `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-We ship on Tuesday.\n+We ship on Thursday.`,
    )!;
    const removed = rows.find((row) => row.kind === "del")!;
    const changed = removed.spans!.filter((span) => span.changed);
    expect(changed.map((span) => span.text)).toEqual(["Tuesday"]);
    // The unchanged prefix must survive intact, not be re-split arbitrarily.
    expect(removed.spans!.map((span) => span.text).join("")).toBe(
      "We ship on Tuesday.",
    );
  });

  it("does not invent word pairings when the runs are different lengths", () => {
    // 1 removed for 2 added has no honest line-to-line correspondence;
    // highlighting one anyway would emphasise the wrong words.
    const rows = parseDiff(MODIFIED)!;
    expect(rows.filter((row) => row.spans !== undefined)).toHaveLength(0);
  });

  it("returns null for a diff with no hunk, so the caller can show the original", () => {
    expect(parseDiff("Binary files a/logo.png and b/logo.png differ")).toBeNull();
    expect(parseDiff("")).toBeNull();
  });
});

describe("diff rendering", () => {
  it("carries add/remove in text, not only in colour", () => {
    render(<DiffView diff={MODIFIED} />);
    // Screen-reader prefixes exist for every row, so the tint is never the
    // only thing distinguishing an addition from a removal.
    expect(screen.getAllByText("Added:", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Removed:", { exact: false }).length).toBeGreaterThan(0);
    expect(
      screen.getByText("2 lines added, 1 line removed.", { exact: false }),
    ).toBeTruthy();
  });

  it("shows an unparseable diff rather than an empty panel", () => {
    render(<DiffView diff="Binary files a/logo.png and b/logo.png differ" />);
    expect(screen.getByText(/Binary files/)).toBeTruthy();
  });

  it("renders diff content as text and never as markup", () => {
    const { container } = render(
      render_diff("+<img src=x onerror=alert(1)>"),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

function render_diff(line: string) {
  return <DiffView diff={`--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n${line}`} />;
}
