import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, History as HistoryIcon, PenLine } from "lucide-react";
import type { HistoryEntry } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { toneFor } from "../board";
import { EmptyState } from "../components/EmptyState";
import { PageHeading } from "../components/PageHeading";
import { Badge, Dot } from "../components/ui/badge";
import { Button, ButtonLink } from "../components/ui/button";
import { ErrorText, Path, Skeleton } from "../components/ui/misc";

/**
 * Applied changes and the tasks they came from (design §4.1).
 *
 * Built on apply operations rather than reviews, which is what lets this screen
 * be honest about the awkward cases. §10.5 writes that row *before* the ref
 * moves and settles it afterwards, so an operation still sitting at `pending`
 * after a restart is a real state the workspace is in — and a `failed` or
 * `ambiguous` one is exactly what someone opens History to find. Listing only
 * successes would make a stuck apply invisible in the one screen meant to
 * explain what happened.
 *
 * No file lists here. Naming changed paths means reading each candidate out of
 * Git, one read per row; the task and the commit are enough to find the detail,
 * and the review still holds it.
 */
export function History({ workspaceId }: { workspaceId: string }) {
  const { api } = useBrowser();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const base = `/w/${workspaceId}`;

  useEffect(() => {
    const controller = new AbortController();
    void api
      .listHistory(workspaceId, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setEntries(rows);
          setFailure(null);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      });
    return () => controller.abort();
  }, [api, workspaceId, nonce]);

  return (
    <>
      <PageHeading
        eyebrow="A record of progress"
        title="History"
        description="Changes that were applied to the approved files, newest first."
      />

      {failure && (
        <div role="alert" className="mb-5 flex flex-wrap items-center gap-3">
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {entries === null ? (
        <div className="space-y-2.5">
          <p role="status" className="sr-only">
            Loading history…
          </p>
          <Skeleton aria-hidden="true" className="h-20" />
          <Skeleton aria-hidden="true" className="h-20" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nothing has been applied yet"
          icon={HistoryIcon}
          action={
            <ButtonLink variant="primary" to={base}>
              Back to the board
            </ButtonLink>
          }
        >
          When an owner applies a reviewed change, it appears here with the task
          it came from.
        </EmptyState>
      ) : (
        /* A rail down the left ties the entries into one timeline. */
        <ol className="relative max-w-3xl space-y-3 before:absolute before:top-3 before:bottom-3 before:left-[7px] before:w-px before:bg-border">
          {entries.map((entry) => {
            const tone = toneFor(entry.status);
            const Icon = entry.taskKind === "manual_edit" ? PenLine : Bot;
            return (
              <li key={entry.applyOperationId} className="relative pl-8">
                <span className="absolute top-4 left-0 grid size-3.5 place-items-center rounded-full border-2 border-background bg-card">
                  <Dot tone={tone} live={entry.status === "pending"} />
                </span>
                <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Link
                      to={`${base}/tasks/${entry.taskId}?tab=Changes`}
                      className="min-w-0 text-[13.5px] font-semibold tracking-tight underline-offset-2 hover:underline"
                    >
                      {entry.taskTitle}
                    </Link>
                    <Badge tone={tone} size="sm" className="ml-auto shrink-0">
                      {LABEL[entry.status]}
                    </Badge>
                  </div>

                  <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon aria-hidden="true" className="size-3" />
                      {entry.taskKind === "manual_edit"
                        ? "Written by hand"
                        : "Produced with agents"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <Path>{entry.candidateSha.slice(0, 8)}</Path>
                    <span aria-hidden="true">·</span>
                    <span>
                      {entry.settledAt
                        ? new Date(entry.settledAt).toLocaleString()
                        : "not settled"}
                    </span>
                  </p>

                  {entry.status !== "applied" && (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      {EXPLAIN[entry.status]}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

const LABEL: Record<HistoryEntry["status"], string> = {
  applied: "Applied",
  pending: "In progress",
  failed: "Did not apply",
  ambiguous: "Needs checking",
};

/**
 * Why a non-applied row is here. §10.5's whole point is that these states are
 * distinguishable — an apply that never ran and one whose outcome is unknown
 * need different responses, so they must not read the same.
 */
const EXPLAIN: Record<HistoryEntry["status"], string> = {
  applied: "",
  pending:
    "This apply was recorded but has not reported an outcome. If it stays here, the server was interrupted mid-apply.",
  failed:
    "The change was not published. The approved files are unchanged, and the review can be refreshed and applied again.",
  ambiguous:
    "The outcome could not be determined, so nothing further was attempted automatically. Someone needs to compare the approved files against this commit before retrying.",
};
