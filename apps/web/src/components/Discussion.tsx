import { useEffect, useRef, useState } from "react";
import { Bot, Clock, FileText, MessageSquare, Plus, Send, Settings2, X } from "lucide-react";
import { MAX_MATERIAL_FILE_BYTES, type DiscussionEntry, type Material, type Participant } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { toneFor } from "../board";
import { cn } from "../lib/utils";
import { setPresenceTyping } from "../presence";
import { refreshLoop } from "../realtime";
import { readDiscussionPages } from "../task-polling";
import { apiMessage } from "../workspace-api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label, Textarea } from "./ui/field";
import { Avatar, ErrorText } from "./ui/misc";

export function Discussion({ workspaceId, taskId, entries, activeRunCutoffSeq, materials, onChanged, busy, participants, presenceId }: {
  workspaceId: string; taskId: string; entries: DiscussionEntry[]; latestSeq: number;
  activeRunCutoffSeq: number | null; materials: Material[]; onChanged: () => void;
  busy: boolean; participants: Participant[]; presenceId: string;
}) {
  const { api, session } = useBrowser();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attached, setAttached] = useState<Material[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const typing = useRef(false);
  const typingSentAt = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingParticipants = participants.filter((person) => person.presenceId !== presenceId && person.typingTaskId === taskId);

  function stopTyping() {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (!typing.current) return;
    typing.current = false;
    setPresenceTyping(workspaceId, presenceId, null);
  }
  function noteTyping(value: string) {
    setBody(value);
    if (!value.trim()) return stopTyping();
    if (!typing.current) {
      typing.current = true;
      typingSentAt.current = Date.now();
      setPresenceTyping(workspaceId, presenceId, taskId);
    } else if (Date.now() - typingSentAt.current > 3_000) {
      typingSentAt.current = Date.now();
      setPresenceTyping(workspaceId, presenceId, taskId);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2_000);
  }
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries.length]);
  useEffect(() => () => stopTyping(), [workspaceId, taskId, presenceId]);

  async function post() {
    if (!body.trim() || pending) return;
    setPending(true); setFailure(null);
    try {
      await api.postDiscussion(workspaceId, taskId, {
        body, guestLabel: session.getGuest().name,
        materialIds: attached.map((material) => material.id), clientRequestId: requestId.current,
      });
      setBody(""); stopTyping(); setAttached([]); requestId.current = crypto.randomUUID(); onChanged();
    } catch (error) { setFailure(apiMessage(error)); }
    finally { setPending(false); }
  }
  async function attach(file: File) {
    setUploadError(null);
    try {
      const { material } = await api.uploadMaterial(workspaceId, file, session.getGuest().name, { taskId });
      setAttached((current) => current.some((item) => item.id === material.id) ? current : [...current, material]);
    } catch (error) { setUploadError(apiMessage(error)); }
    finally { if (fileInput.current) fileInput.current.value = ""; }
  }

  return (
    <div className="flex h-[clamp(360px,72vh,640px)] flex-col overflow-hidden rounded-xl border border-border bg-card">
      {entries.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
          <div className="max-w-md">
            <MessageSquare aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
            <h2 className="text-[15px] font-semibold tracking-tight">Start the conversation</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Share context, ask a question, or attach a file for everyone working on this task.
            </p>
          </div>
        </div>
      ) : (
        <ol ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-5 sm:px-5">
          {entries.map((entry) => <DiscussionItem key={entry.id} entry={entry} materials={materials} workspaceId={workspaceId} taskId={taskId} participants={participants} onChanged={onChanged} />)}
        </ol>
      )}
      <div className="min-h-6 px-5 text-[11.5px] text-muted-foreground" aria-live="polite">
        {typingParticipants.length > 0 && <span>
          {typingParticipants.slice(0, 2).map((person) => person.name).join(" and ")}
          {typingParticipants.length > 2 ? ` and ${typingParticipants.length - 2} more` : ""}
          {typingParticipants.length === 1 ? " is" : " are"} typing<span aria-hidden="true" className="ml-1 tracking-widest">•••</span>
        </span>}
      </div>
      <form className="border-t border-border bg-muted/20 p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); void post(); }}>
        {activeRunCutoffSeq !== null && <small className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>An attempt is running. New messages are saved, but this run will not read them unless they answer an agent question.</span>
        </small>}
        {attached.length > 0 && <ul className="mb-2 flex flex-wrap gap-1.5">{attached.map((material) => <li key={material.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-card py-1 pr-1 pl-2.5 text-[11.5px]">
          <FileText aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" /><span className="max-w-[180px] truncate">{material.filename}</span>
          <Button size="icon-sm" variant="ghost" aria-label={`Remove ${material.filename}`} onClick={() => setAttached((current) => current.filter((item) => item.id !== material.id))}><X aria-hidden="true" /></Button>
        </li>)}</ul>}
        {(failure || uploadError) && <div className="mb-2 space-y-1">{failure && <ErrorText role="alert">{failure}</ErrorText>}{uploadError && <ErrorText role="alert">{uploadError}</ErrorText>}</div>}
        <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring">
          <label className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Add material">
            <Plus aria-hidden="true" className="size-5" /><span className="sr-only">Add material</span>
            <input ref={fileInput} type="file" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(file); }} />
          </label>
          <Label htmlFor="discussion-body" className="sr-only">Message</Label>
          <Textarea id="discussion-body" rows={1} value={body} maxLength={20000} onChange={(event) => noteTyping(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void post(); } }}
            placeholder="Message this task" className="max-h-36 min-h-10 resize-none border-0 bg-transparent px-2 py-2.5 shadow-none focus-visible:ring-0" />
          <Button size="icon" variant="primary" type="submit" disabled={pending || busy || !body.trim()} aria-label="Send message"><Send aria-hidden="true" /></Button>
        </div>
        <small className="mt-1.5 block px-1 text-[10.5px] text-muted-foreground">Enter to send · Shift+Enter for a new line · files up to {Math.round(MAX_MATERIAL_FILE_BYTES / 1024 / 1024)} MB</small>
      </form>
    </div>
  );
}

const ACTOR = { guest: { label: "Guest", Icon: null }, agent: { label: "Agent", Icon: Bot }, system: { label: "System", Icon: Settings2 } } as const;

function DiscussionItem({ entry, materials, workspaceId, taskId, participants, onChanged }: {
  entry: DiscussionEntry; materials: Material[]; workspaceId: string; taskId: string; participants: Participant[]; onChanged: () => void;
}) {
  const { api, session } = useBrowser();
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const open = entry.question?.role === "asked" && entry.question.status === "open";
  async function submitAnswer() {
    if (!answer.trim() || pending || !entry.question) return;
    setPending(true); setFailure(null);
    try {
      await api.answerQuestion(workspaceId, taskId, { questionId: entry.question.id, body: answer, guestLabel: session.getGuest().name, clientRequestId: requestId.current });
      setAnswer(""); requestId.current = crypto.randomUUID(); onChanged();
    } catch (error) { setFailure(apiMessage(error)); }
    finally { setPending(false); }
  }
  const attachments = entry.materialIds.map((id) => materials.find((material) => material.id === id)).filter((material): material is Material => material !== undefined);
  const author = entry.actorType === "guest" ? (entry.guestLabel ?? "Guest") : (ACTOR[entry.actorType]?.label ?? "System");
  const Icon = entry.actorType === "guest" ? null : ACTOR[entry.actorType]?.Icon;
  const isHost = entry.actorType === "guest" && participants.some((person) => person.isHost && person.name === author);
  const sentAt = new Date(entry.createdAt);
  return <li className={cn("group flex gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/35", open && "bg-amber-50/60 dark:bg-amber-950/20")}>
    <div className="pt-0.5">{Icon ? <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full border border-border bg-card text-muted-foreground"><Icon className="size-3.5" /></span> : <Avatar name={author} size="sm" />}</div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-[12.5px] font-semibold">{author}</span>
        {isHost && <Badge tone="brand" size="sm">Host</Badge>}
        <time dateTime={entry.createdAt} title={sentAt.toLocaleString()} className="text-[10.5px] text-muted-foreground">{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(sentAt)}</time>
        {entry.question && <Badge tone={toneFor(entry.question.status)} size="sm">{entry.question.role === "asked" ? `Question · ${entry.question.status}` : "Answer"}</Badge>}
        {entry.afterActiveRunCutoff && <Badge tone="warn" size="sm">After run started</Badge>}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{entry.body}</p>
      {attachments.length > 0 && <ul className="mt-2.5 flex flex-wrap gap-1.5">{attachments.map((material) => <li key={material.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2 py-1 text-[11.5px]"><FileText aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />{material.filename}</li>)}</ul>}
      {open && <form className="mt-3.5 space-y-2.5 rounded-lg border border-border bg-card p-3.5" onSubmit={(event) => { event.preventDefault(); void submitAnswer(); }}>
        <Label htmlFor={`answer-${entry.id}`}>Answer this question</Label>
        <Textarea id={`answer-${entry.id}`} rows={2} maxLength={20000} value={answer} onChange={(event) => setAnswer(event.target.value)} />
        {failure && <ErrorText role="alert">{failure}</ErrorText>}
        <Button type="submit" variant="primary" size="sm" disabled={pending}>{pending ? "Sending…" : "Send answer"}</Button>
      </form>}
    </div>
  </li>;
}

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
    const controller = new AbortController(); let stopped = false;
    const pull = async () => {
      try {
        const page = await readDiscussionPages(api, workspaceId, taskId, controller.signal);
        if (controller.signal.aborted || stopped) return;
        setEntries(page.entries); setLatestSeq(page.latestSeq); setCutoff(page.activeRunCutoffSeq); setFailure(null);
      } catch (error) { if (!controller.signal.aborted && !stopped) setFailure(apiMessage(error)); }
      finally { if (!controller.signal.aborted && !stopped) setLoading(false); }
    };
    const stopRefresh = refreshLoop(workspaceId, taskId, pull, () => 5000);
    return () => { stopped = true; controller.abort(); stopRefresh(); };
  }, [api, workspaceId, taskId, nonce]);
  return { entries, latestSeq, activeRunCutoffSeq: cutoff, loading, failure, refresh: () => setNonce((value) => value + 1) };
}
