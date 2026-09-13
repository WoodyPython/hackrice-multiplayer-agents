import { useEffect, useRef, useState } from "react";
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
import { EmptyState } from "./EmptyState";

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
    <div className="discussion">
      {entries.length === 0 ? (
        <EmptyState title="Start with a conversation">
          Discuss the requirements and selected inputs before starting. Posting
          a task starts no agents.
        </EmptyState>
      ) : (
        <ol className="entries">
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
        className="compose"
        onSubmit={(event) => {
          event.preventDefault();
          void post();
        }}
      >
        <label htmlFor="discussion-body">Add to the discussion</label>
        <textarea
          id="discussion-body"
          rows={3}
          value={body}
          maxLength={20000}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Ask something, or add detail the task should account for."
        />
        {activeRunCutoffSeq !== null && (
          <small className="muted">
            An attempt is running. Comments added now are recorded, but this
            run's agents will not read them — answer an agent's question, or
            stop the run and start a revised attempt.
          </small>
        )}
        {attached.length > 0 && (
          <ul className="attachments">
            {attached.map((material) => (
              <li key={material.id}>
                ▤ {material.filename}
                <button
                  type="button"
                  onClick={() =>
                    setAttached((current) =>
                      current.filter((item) => item.id !== material.id),
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {failure && (
          <p role="alert" className="error">
            {failure}
          </p>
        )}
        {uploadError && (
          <p role="alert" className="error">
            {uploadError}
          </p>
        )}
        <div className="compose-footer">
          <label className="attach-control">
            <span>Attach a file</span>
            <input
              ref={fileInput}
              type="file"
              accept={SUPPORTED_TEXT_EXTENSIONS.join(",")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void attach(file);
              }}
            />
          </label>
          <small className="muted">
            Text only — Markdown, plain text, and code, up to{" "}
            {Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB. PDFs and images are
            rejected.
          </small>
          <button className="primary" type="submit" disabled={pending || busy}>
            {pending ? "Posting…" : "Post comment"}
          </button>
        </div>
      </form>
      <p className="muted" aria-live="polite">
        {latestSeq === 0
          ? "No entries yet."
          : `${latestSeq} entr${latestSeq === 1 ? "y" : "ies"} in this task.`}
      </p>
    </div>
  );
}

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
  const open = entry.question?.role === "asked" && entry.question.status === "open";

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

  return (
    <li className={`entry actor-${entry.actorType}`}>
      <div className="entry-head">
        <span className="author">
          {entry.actorType === "guest"
            ? (entry.guestLabel ?? "Guest")
            : entry.actorType === "agent"
              ? "Agent"
              : "System"}
        </span>
        {entry.question && (
          <span className={`question-tag status-${entry.question.status}`}>
            {entry.question.role === "asked"
              ? `Question · ${entry.question.status}`
              : "Answer"}
          </span>
        )}
        {entry.afterActiveRunCutoff && (
          <span className="cutoff-tag">Added after this run started</span>
        )}
      </div>
      <p className="entry-body">{entry.body}</p>
      {attachments.length > 0 && (
        <ul className="attachments">
          {attachments.map((material) => (
            <li key={material.id}>▤ {material.filename}</li>
          ))}
        </ul>
      )}
      {open && (
        <form
          className="answer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer();
          }}
        >
          <label htmlFor={`answer-${entry.id}`}>
            Answer this question
          </label>
          <textarea
            id={`answer-${entry.id}`}
            rows={2}
            maxLength={20000}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <small className="muted">
            The waiting agent receives this directly. Its deadline keeps running
            while it waits.
          </small>
          {failure && (
            <p role="alert" className="error">
              {failure}
            </p>
          )}
          <button type="submit" className="primary" disabled={pending}>
            {pending ? "Sending…" : "Send answer"}
          </button>
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
        const page = await readDiscussionPages(api, workspaceId, taskId, controller.signal);
        if (controller.signal.aborted || stopped) return;
        setEntries(page.entries);
        setLatestSeq(page.latestSeq);
        setCutoff(page.activeRunCutoffSeq);
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted && !stopped) setFailure(apiMessage(error));
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
