import { useMemo } from "react";
import { cn } from "../lib/utils";

/**
 * A unified `git diff` rendered as a table instead of a wall of text.
 *
 * The server hands us `git diff` stdout verbatim (§10.4 keeps the candidate's
 * real diff as the evidence), so this parses that text rather than asking for a
 * new API shape. Three properties matter:
 *
 * **Colour is never the only signal.** Every row carries a `+`/`-`/` ` glyph in
 * its own gutter cell and an off-screen label. A red/green-only diff is
 * unreadable with a red-green deficiency and silent to a screen reader.
 *
 * **Nothing here executes or interprets the content.** §13.2 keeps generated
 * content inert: every cell is text, and no line is ever parsed as markup.
 *
 * **A diff we cannot parse is shown, not swallowed.** If the text has no hunk
 * header — a binary file, a mode-only change, an empty diff — the original is
 * rendered as-is rather than replaced with a blank panel claiming no changes.
 */

type RowKind = "add" | "del" | "context" | "meta" | "marker";

interface Row {
  kind: RowKind;
  text: string;
  oldLine?: number;
  newLine?: number;
  /** Intra-line spans, when this row could be paired with its counterpart. */
  spans?: Array<{ text: string; changed: boolean }>;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Split into word-ish tokens, keeping whitespace so rejoining is lossless. */
function tokenize(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_]+|[^\s A-Za-z0-9_]/g) ?? [];
}

/**
 * Longest common subsequence over tokens, used to mark what actually changed
 * inside a replaced line. Quadratic, so it is only attempted on short pairs —
 * a 4000-character minified line would cost more than the emphasis is worth.
 */
function wordSpans(before: string, after: string) {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > 400 || b.length > 400) return null;
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const left: Row["spans"] = [];
  const right: Row["spans"] = [];
  const push = (into: Row["spans"], text: string, changed: boolean) => {
    const last = into![into!.length - 1];
    if (last && last.changed === changed) last.text += text;
    else into!.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(left, a[i]!, false);
      push(right, b[j]!, false);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push(left, a[i]!, true);
      i++;
    } else {
      push(right, b[j]!, true);
      j++;
    }
  }
  while (i < a.length) push(left, a[i++]!, true);
  while (j < b.length) push(right, b[j++]!, true);
  return { left, right };
}

/**
 * Pair each run of removed lines with the additions that immediately follow it,
 * so a one-word edit reads as a one-word edit. Only equal-length runs are
 * paired: a 2-for-5 replacement has no honest line-to-line correspondence, and
 * inventing one would highlight the wrong words.
 */
function addWordSpans(rows: Row[]): void {
  let index = 0;
  while (index < rows.length) {
    if (rows[index]!.kind !== "del") {
      index++;
      continue;
    }
    let end = index;
    while (rows[end]?.kind === "del") end++;
    let plus = end;
    while (rows[plus]?.kind === "add") plus++;
    const removed = end - index;
    const added = plus - end;
    if (removed > 0 && removed === added) {
      for (let offset = 0; offset < removed; offset++) {
        const from = rows[index + offset]!;
        const to = rows[end + offset]!;
        const spans = wordSpans(from.text, to.text);
        if (spans) {
          from.spans = spans.left;
          to.spans = spans.right;
        }
      }
    }
    index = plus > end ? plus : end;
  }
}

export function parseDiff(diff: string): Row[] | null {
  const lines = diff.split("\n");
  const rows: Row[] = [];
  let oldLine = 0;
  let newLine = 0;
  let started = false;

  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      started = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      // `@@ -1,6 +1,7 @@` is developer shorthand for a line range. This screen
      // is read by people deciding whether to publish writing, so the range is
      // spelled out; git's own section context is kept when it supplies one.
      const span = Number(hunk[4] ?? "1");
      const last = newLine + Math.max(span, 1) - 1;
      const context = (hunk[5] ?? "").trim();
      rows.push({
        kind: "meta",
        text: `Lines ${newLine}–${last}${context ? ` · ${context}` : ""}`,
      });
      continue;
    }
    // Everything before the first hunk is `diff --git` / `index` / `---` /
    // `+++`, which repeat the path and hashes the caller already displays.
    if (!started) continue;
    if (line.startsWith("\\")) {
      rows.push({ kind: "marker", text: line.slice(1).trim() });
      continue;
    }
    const body = line.slice(1);
    if (line.startsWith("+")) rows.push({ kind: "add", text: body, newLine: newLine++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: body, oldLine: oldLine++ });
    else if (line.startsWith(" ") || line === "")
      rows.push({ kind: "context", text: body, oldLine: oldLine++, newLine: newLine++ });
  }

  // A trailing empty line is an artefact of splitting on "\n", not a context line.
  while (rows.length && rows[rows.length - 1]!.kind === "context" && rows[rows.length - 1]!.text === "") {
    rows.pop();
  }
  if (!started) return null;
  addWordSpans(rows);
  return rows;
}

const GUTTER = "w-[1px] min-w-0 px-2 text-right align-top tabular-nums select-none";

function LineCell({ row }: { row: Row }) {
  if (!row.spans) return <>{row.text || " "}</>;
  return (
    <>
      {row.spans.map((span, index) =>
        span.changed ? (
          <mark
            key={index}
            className={cn(
              "rounded-[3px] bg-(--color-diff-del-word) text-inherit",
              row.kind === "add" && "bg-(--color-diff-add-word)",
            )}
          >
            {span.text}
          </mark>
        ) : (
          <span key={index}>{span.text}</span>
        ),
      )}
    </>
  );
}

export function DiffView({
  diff,
  className,
}: {
  diff: string;
  className?: string;
}) {
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const counts = useMemo(() => {
    const added = rows?.filter((row) => row.kind === "add").length ?? 0;
    const removed = rows?.filter((row) => row.kind === "del").length ?? 0;
    return { added, removed };
  }, [rows]);

  // Unparseable: a binary file, a mode-only change, or an empty diff. Showing
  // the original text is honest; an empty panel would read as "no changes".
  if (!rows)
    return (
      <pre
        className={cn(
          "cf-diff max-h-96 overflow-auto p-3.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap",
          className,
        )}
      >
        {diff.trim() || "No textual diff is available for this file."}
      </pre>
    );

  return (
    <div className={cn("cf-diff", className)}>
      <p className="sr-only">
        {counts.added} line{counts.added === 1 ? "" : "s"} added, {counts.removed}{" "}
        line{counts.removed === 1 ? "" : "s"} removed.
      </p>
      <div className="max-h-[30rem] overflow-auto">
        <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.65]">
          <tbody>
            {rows.map((row, index) => {
              if (row.kind === "meta")
                return (
                  <tr key={index} className="bg-(--color-diff-meta)">
                    <td
                      colSpan={3}
                      className="px-3 py-1 text-[10.5px] tracking-wide text-muted-foreground"
                    >
                      {row.text}
                    </td>
                  </tr>
                );
              if (row.kind === "marker")
                return (
                  <tr key={index}>
                    <td colSpan={3} className="px-3 py-1 text-[10.5px] text-muted-foreground italic">
                      {row.text}
                    </td>
                  </tr>
                );
              const add = row.kind === "add";
              const del = row.kind === "del";
              return (
                <tr
                  key={index}
                  className={cn(
                    add && "bg-(--color-diff-add-bg)",
                    del && "bg-(--color-diff-del-bg)",
                  )}
                >
                  <td className={cn(GUTTER, "text-[10.5px] text-muted-foreground")}>
                    {row.oldLine ?? ""}
                  </td>
                  <td className={cn(GUTTER, "text-[10.5px] text-muted-foreground")}>
                    {row.newLine ?? ""}
                  </td>
                  <td className="w-full py-px pr-3 pl-2 align-top break-words whitespace-pre-wrap">
                    {/* The glyph, not the tint, is what carries add vs. remove. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mr-2 inline-block w-[0.6em] select-none",
                        add && "text-(--color-diff-add-ink)",
                        del && "text-(--color-diff-del-ink)",
                        !add && !del && "text-border",
                      )}
                    >
                      {add ? "+" : del ? "−" : " "}
                    </span>
                    <span className="sr-only">
                      {add ? "Added: " : del ? "Removed: " : "Unchanged: "}
                    </span>
                    <LineCell row={row} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
