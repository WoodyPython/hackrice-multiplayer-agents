import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Clock,
  FileText,
  MessageSquare,
  Paperclip,
  Send,
  Settings2,
  X,
} from "lucide-react";
import {
  MAX_TEXT_FILE_BYTES,
  SUPPORTED_TEXT_EXTENSIONS,
  type DiscussionEntry,
  type Material,
} from "@app/contracts";
import { useBrowser } from "../browser-context";
import { refreshLoop } from "../realtime";
import { readDiscussionPages } from "../task-polling";
import { apiMessage } from "../workspace-api";
import { toneFor } from "../board";
import { cn } from "../lib/utils";
import { EmptyState } from "./EmptyState";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label, Textarea } from "./ui/field";
import { Avatar, ErrorText } from "./ui/misc";

/**
 * Task-local discussion (design §1.1, §2.3, §2.6).
 *
 * Three properties here are load-bearing and none of them are cosmetic:
 *
 * **Entries above the active run's cutoff are labelled.** §2.3 freezes a run's
 * inputs at Start, so a comment added afterwards reaches no agent in that run.
 * The server computes `afterActiveRunCutoff`; showing it is the only way a
 * contributor can tell that the thing they just typed will not be read.
 *
 * **A question is not a comment.** §2.6 makes it a record with a status, and
 * answering routes through `/answer` so it reaches the waiting agent. Replying
 * in the normal box would post an ordinary entry above the cutoff, which the
 * agent would never see — the same words, silently doing nothing.
 *
 * **Bodies render as text.** React escapes children, and nothing here reaches
 * for `dangerouslySetInnerHTML`. §13.3: an agent or a guest can put markup in a
 * body, and this origin also serves the workspace.
 */
export function Discussion({
  workspaceId,
  taskId,
  entries,
  latestSeq,
  activeRunCutoffSeq,
  materials,
  onChanged,
  busy,
}: {
  workspaceId: string;
  taskId: string;
  entries: DiscussionEntry[];
  latestSeq: number;
  activeRunCutoffSeq: number | null;
  materials: Material[];
  onChanged: () => void;
  busy: boolean;
}) {
  const { api, session } = useBrowser();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attached, setAttached] = useState<Material[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // One id per user intent, reused across retries so a retried post resolves to
  // the original entry rather than creating a second (interface note).
  const requestId = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);

  async function post() {
    if (!body.trim() || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await api.postDiscussion(workspaceId, taskId, {
        body,
        guestLabel: session.getGuest().name,
        materialIds: attached.map((material) => material.id),
        clientRequestId: requestId.current,
      });
      setBody("");
      setAttached([]);
      requestId.current = crypto.randomUUID();
      onChanged();
    } catch (error) {
      // The text stays in the box; the id stays the same so a retry replays.
      setFailure(apiMessage(error));
    } finally {
      setPending(false);
    }
  }

  async function attach(file: File) {
    setUploadError(null);
    try {
      const { material } = await api.uploadMaterial(
        workspaceId,
        file,
        session.getGuest().name,
        { taskId },
      );
      // Identical bytes reuse the existing material (200 rather than 201), so
      // guard against listing the same one twice.
      setAttached((current) =>
        current.some((existing) => existing.id === material.id)
          ? current
          : [...current, material],
      );
    } catch (error) {
      setUploadError(apiMessage(error));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      {entries.length === 0 ? (
        <EmptyState title="Start with a conversation" icon={MessageSquare}>
          Discuss the requirements and selected inputs before starting. Posting
          a task starts no agents.
        </EmptyState>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => (
            <DiscussionItem
              key={entry.id}
              entry={entry}
              materials={materials}
              workspaceId={workspaceId}
              taskId={taskId}
              onChanged={onChanged}
            />
          ))}
        </ol>
      )}

      <form
        className="space-y-3 rounded-xl border border-border bg-muted/25 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void post();
        }}
      >
        <Label htmlFor="discussion-body">Add to the discussion</Label>
        <Textarea
          id="discussion-body"
          rows={3}
          value={body}
          maxLength={20000}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Ask something, or add detail the task should account for."
        />

        {activeRunCutoffSeq !== null && (
          <small className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              An attempt is running. Comments added now are recorded, but this
              run's agents will not read them — answer an agent's question, or
              stop the run and start a revised attempt.
            </span>
          </small>
        )}

        {attached.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {attached.map((material) => (
              <li
                key={material.id}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card py-1 pr-1 pl-2.5 text-[11.5px]"
              >
                <FileText
                  aria-hidden="true"
                  className="size-3 shrink-0 text-muted-foreground"
                />
                <span className="max-w-[180px] truncate">
                  {material.filename}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${material.filename}`}
                  onClick={() =>
                    setAttached((current) =>
                      current.filter((item) => item.id !== material.id),
                    )
                  }
                >
                  <X aria-hidden="true" />
                  <span className="sr-only">Remove</span>
                </Button>
              </li>
            ))}
          </ul>
        )}

        {failure && <ErrorText role="alert">{failure}</ErrorText>}
        {uploadError && <ErrorText role="alert">{uploadError}</ErrorText>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-muted">
              <Paperclip aria-hidden="true" className="size-3.5" />
              <span>Attach a file</span>
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                accept={SUPPORTED_TEXT_EXTENSIONS.join(",")}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void attach(file);
                }}
              />
            </label>
            <small className="mt-1.5 block text-[11px] text-muted-foreground">
              Text only — Markdown, plain text, and code, up to{" "}
              {Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB. PDFs and images are
              rejected.
            </small>
          </div>
          <Button variant="primary" type="submit" disabled={pending || busy}>
            <Send aria-hidden="true" />
            {pending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </form>

      <p className="text-[11.5px] text-muted-foreground" aria-live="polite">
        {latestSeq === 0
          ? "No entries yet."
          : `${latestSeq} entr${latestSeq === 1 ? "y" : "ies"} in this task.`}
      </p>
    </div>
  );
}

const ACTOR = {
  guest: { label: "Guest", Icon: null },
  agent: { label: "Agent", Icon: Bot },
  system: { label: "System", Icon: Settings2 },
} as const;

/** One entry, plus the answer affordance when it carries an open question. */
function DiscussionItem({
  entry,
  materials,
  workspaceId,
  taskId,
  onChanged,
}: {
  entry: DiscussionEntry;
  materials: Material[];
  workspaceId: string;
  taskId: string;
  onChanged: () => void;
}) {
  const { api, session } = useBrowser();
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const open =
    entry.question?.role === "asked" && entry.question.status === "open";

  async function submitAnswer() {
    if (!answer.trim() || pending || !entry.question) return;
    setPending(true);
    setFailure(null);
    try {
      await api.answerQuestion(workspaceId, taskId, {
        questionId: entry.question.id,
        body: answer,
        guestLabel: session.getGuest().name,
        clientRequestId: requestId.current,
      });
      setAnswer("");
      requestId.current = crypto.randomUUID();
      onChanged();
    } catch (error) {
      setFailure(apiMessage(error));
    } finally {
      setPending(false);
    }
  }

  const attachments = entry.materialIds
    .map((id) => materials.find((material) => material.id === id))
    .filter((material): material is Material => material !== undefined);

  const author =
    entry.actorType === "guest"
      ? (entry.guestLabel ?? "Guest")
      : (ACTOR[entry.actorType]?.label ?? "System");
  const Icon =
    entry.actorType === "guest" ? null : ACTOR[entry.actorType]?.Icon;

  return (
    <li
      className={cn(
        "rounded-xl border p-4",
        entry.actorType === "agent"
          ? "border-navy-200/70 bg-navy-50/40 dark:border-navy-800 dark:bg-navy-950/30"
          : entry.actorType === "system"
            ? "border-dashed border-border bg-transparent"
            : "border-border bg-card",
        open && "ring-1 ring-amber-300/70 dark:ring-amber-800",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {Icon ? (
          <span
            aria-hidden="true"
            className="grid size-5 shrink-0 place-items-center rounded-full border border-border bg-card text-muted-foreground"
          >
            <Icon className="size-3" />
          </span>
        ) : (
          <Avatar name={author} size="sm" />
        )}
        <span className="text-[12.5px] font-semibold">{author}</span>
        {entry.question && (
          <Badge tone={toneFor(entry.question.status)} size="sm">
            {entry.question.role === "asked"
              ? `Question · ${entry.question.status}`
              : "Answer"}
          </Badge>
        )}
        {entry.afterActiveRunCutoff && (
          <Badge tone="warn" size="sm">
            Added after this run started
          </Badge>
        )}
      </div>

      <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap">
        {entry.body}
      </p>

      {attachments.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {attachments.map((material) => (
            <li
              key={material.id}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2 py-1 text-[11.5px]"
            >
              <FileText
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground"
              />
              {material.filename}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form
          className="mt-3.5 space-y-2.5 rounded-lg border border-border bg-card p-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer();
          }}
        >
          <Label htmlFor={`answer-${entry.id}`}>Answer this question</Label>
          <Textarea
            id={`answer-${entry.id}`}
            rows={2}
            maxLength={20000}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <small className="block text-[11.5px] text-muted-foreground">
            The waiting agent receives this directly. Its deadline keeps running
            while it waits.
          </small>
          {failure && <ErrorText role="alert">{failure}</ErrorText>}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={pending}
            className="w-full sm:w-auto"
          >
            {pending ? "Sending…" : "Send answer"}
          </Button>
        </form>
      )}
    </li>
  );
}

/** Refresh the complete thread because questions and cutoff labels mutate in place.
 * Publish only a successful paginated snapshot; failed refreshes keep the last good thread.
 */
export function useDiscussion(workspaceId: string, taskId: string | undefined) {
  const { api } = useBrowser();
  const [entries, setEntries] = useState<DiscussionEntry[]>([]);
  const [latestSeq, setLatestSeq] = useState(0);
  const [cutoff, setCutoff] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    let stopped = false;

    const pull = async () => {
      try {
        const page = await readDiscussionPages(
          api,
          workspaceId,
          taskId,
          controller.signal,
        );
        if (controller.signal.aborted || stopped) return;
        setEntries(page.entries);
        setLatestSeq(page.latestSeq);
        setCutoff(page.activeRunCutoffSeq);
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted && !stopped)
          setFailure(apiMessage(error));
      } finally {
        if (!controller.signal.aborted && !stopped) {
          setLoading(false);
        }
      }
    };
    const stopRefresh = refreshLoop(workspaceId, taskId, pull, () => 5000);
    return () => {
      stopped = true;
      controller.abort();
      stopRefresh();
    };
  }, [api, workspaceId, taskId, nonce]);

  return {
    entries,
    latestSeq,
    activeRunCutoffSeq: cutoff,
    loading,
    failure,
    /** Call after a write: re-reads in full so in-place changes are picked up. */
    refresh: () => {
      setNonce((value) => value + 1);
    },
  };
}
