import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Check, ChevronRight, Lightbulb, MessageSquareText, Wrench, X } from "lucide-react";
import type { AgentHistoryDetail, AgentHistoryEntry, AgentTraceStep } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { humanizeStatus, toneFor } from "../board";
import { DiffView } from "./DiffView";
import { EmptyState } from "./EmptyState";
import { Badge, Dot } from "./ui/badge";
import { Button, ButtonLink } from "./ui/button";
import { ErrorText, Notice, Path, Skeleton } from "./ui/misc";

/**
 * History → Agent work: agents that are done working, each with its recorded
 * thought process and the file changes it made.
 *
 * The detail is read only when someone opens an agent. It reads Git for the
 * diff, and a workspace can accumulate hundreds of finished agents.
 *
 * Everything an agent wrote — reasoning, replies, summaries — is generated and
 * rendered as inert text, labelled as such, the same as elsewhere in the app.
 */
export function AgentHistory({
  workspaceId,
  focusAgentId,
}: {
  workspaceId: string;
  /** Open and scroll to this agent, e.g. when arriving from the Agents page. */
  focusAgentId?: string | null;
}) {
  const { api } = useBrowser();
  const [agents, setAgents] = useState<AgentHistoryEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const base = `/w/${workspaceId}`;

  useEffect(() => {
    const controller = new AbortController();
    void api
      .listAgentHistory(workspaceId, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setAgents(rows);
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
      {failure && (
        <div role="alert" className="mb-5 flex flex-wrap items-center gap-3">
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {agents === null ? (
        !failure && (
          <div className="space-y-2.5">
            <p role="status" className="sr-only">
              Loading agent history…
            </p>
            <Skeleton aria-hidden="true" className="h-24" />
            <Skeleton aria-hidden="true" className="h-24" />
          </div>
        )
      ) : agents.length === 0 ? (
        <EmptyState
          title="No finished agents yet"
          icon={Bot}
          action={
            <ButtonLink variant="primary" to={`${base}/agents`}>
              View agents
            </ButtonLink>
          }
        >
          When an agent finishes working, its thought process and the changes it made appear here.
        </EmptyState>
      ) : (
        <ol className="relative max-w-4xl space-y-3 before:absolute before:top-3 before:bottom-3 before:left-[7px] before:w-px before:bg-border">
          {agents.map((agent) => (
            <AgentCard
              key={agent.agentInstanceId}
              agent={agent}
              workspaceId={workspaceId}
              focused={agent.agentInstanceId === focusAgentId}
            />
          ))}
        </ol>
      )}
    </>
  );
}

function AgentCard({
  agent,
  workspaceId,
  focused,
}: {
  agent: AgentHistoryEntry;
  workspaceId: string;
  focused: boolean;
}) {
  const tone = toneFor(agent.status);
  const item = useRef<HTMLLIElement>(null);
  const [open, setOpen] = useState(focused);

  useEffect(() => {
    if (focused) item.current?.scrollIntoView?.({ block: "start" });
  }, [focused]);

  return (
    <li ref={item} className="relative pl-8" aria-label={`${agent.assignmentKey} on ${agent.taskTitle}`}>
      <span className="absolute top-4 left-0 grid size-3.5 place-items-center rounded-full border-2 border-background bg-card">
        <Dot tone={tone} />
      </span>
      <article className="rounded-xl border border-border bg-card shadow-xs">
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Bot aria-hidden="true" className="size-4 text-muted-foreground" />
            <h3 className="text-[13.5px] font-semibold tracking-tight break-all">{agent.assignmentKey}</h3>
            <Badge size="sm">{agent.preset}</Badge>
            <Badge tone={tone} size="sm" className="ml-auto shrink-0">
              {humanizeStatus(agent.status)}
            </Badge>
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
            <Link
              to={`/w/${workspaceId}/tasks/${agent.taskId}?tab=Agents&from=agent-history`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {agent.taskTitle}
            </Link>
            <span aria-hidden="true">·</span>
            <span>Attempt {agent.attempt}</span>
            <span aria-hidden="true">·</span>
            <span>
              {agent.endedAt ? <>Ended <Timestamp value={agent.endedAt} /></> : "End time not recorded"}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {agent.stepCount} recorded step{agent.stepCount === 1 ? "" : "s"}
            </span>
          </p>
          {agent.summary ? (
            <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
              {agent.summary}
            </p>
          ) : (
            <p className="mt-2 text-[12.5px] text-muted-foreground">{agent.instructionSummary}</p>
          )}
        </div>

        <details
          open={open}
          className="group border-t border-border"
          onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[12.5px] font-medium transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
            />
            Thought process and changes
          </summary>
          {open && <AgentDetail workspaceId={workspaceId} agent={agent} />}
        </details>
      </article>
    </li>
  );
}

function AgentDetail({ workspaceId, agent }: { workspaceId: string; agent: AgentHistoryEntry }) {
  const { api } = useBrowser();
  const [detail, setDetail] = useState<AgentHistoryDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void api
      .readAgentHistory(workspaceId, agent.agentInstanceId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(apiMessage(error));
      });
    return () => controller.abort();
  }, [api, workspaceId, agent.agentInstanceId, nonce]);

  if (failure)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 border-t border-border p-4">
        <ErrorText>{failure}</ErrorText>
        <Button size="sm" onClick={() => setNonce((value) => value + 1)}>
          Try again
        </Button>
      </div>
    );

  if (!detail)
    return (
      <div className="space-y-2 border-t border-border p-4">
        <p role="status" className="sr-only">
          Loading thought process…
        </p>
        <Skeleton aria-hidden="true" className="h-16" />
      </div>
    );

  return (
    <div className="space-y-6 border-t border-border p-4">
      {agent.status !== "completed" && (
        <Notice role="status" tone="warn" title={OUTCOME_TITLE[agent.status] ?? "This agent did not finish"}>
          <p>{failureText(detail.failureCode)}</p>
        </Notice>
      )}

      {agent.summary && (
        <section className="space-y-1.5">
          <h4 className="text-[12px] font-semibold">Result summary</h4>
          <p className="max-h-64 overflow-auto text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
            {agent.summary}
          </p>
          {detail.limitations.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted-foreground">
              {detail.limitations.map((limitation, index) => (
                <li key={index}>{limitation}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-2.5" aria-label="Thought process">
        <div>
          <h4 className="text-[12px] font-semibold">Thought process</h4>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Reasoning is the model’s own summary of its thinking. It is generated and has not been checked.
          </p>
        </div>
        {detail.steps.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">
            No thought process was recorded for this agent.
          </p>
        ) : (
          <ol className="space-y-2">
            {detail.steps.map((step) => (
              <TraceStep key={step.id} step={step} />
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-2.5" aria-label="Changes">
        <h4 className="text-[12px] font-semibold">
          {!detail.changes.available || detail.changes.changedFiles.length === 0
            ? "Changes"
            : `${detail.changes.changedFiles.length} changed file${detail.changes.changedFiles.length === 1 ? "" : "s"}`}
        </h4>
        {!detail.changes.available ? (
          <p className="text-[12.5px] text-muted-foreground">
            This agent’s changes could not be read from the workspace history.
          </p>
        ) : detail.changes.changedFiles.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">
            {agent.writePaths.length === 0
              ? "This agent was read-only and did not change files."
              : "This agent did not save any file changes."}
          </p>
        ) : (
          <div className="grid gap-2">
            {detail.changes.changedFiles.map((file) => (
              <FileDiff key={file.path} file={file} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function TraceStep({ step }: { step: AgentTraceStep }) {
  if (step.kind === "tool_results")
    return (
      <li className="ml-6 space-y-1">
        {step.results.map((result, index) => (
          <p key={index} className="flex items-start gap-2 text-[12px] text-muted-foreground">
            {result.outcome === "ok" ? (
              <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" />
            )}
            <span>
              {result.outcome === "ok"
                ? `${TOOL_NAME[result.name] ?? result.name} succeeded`
                : `${TOOL_NAME[result.name] ?? result.name} was refused: ${toolErrorText(result.errorCode)}`}
            </span>
          </p>
        ))}
      </li>
    );

  return (
    <li className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-[10.5px] tracking-wide text-muted-foreground">
        <Timestamp value={step.createdAt} />
      </p>
      {step.thoughts && (
        <div className="flex gap-2">
          <Lightbulb aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <span className="sr-only">Reasoning: </span>
            <p className="max-h-72 overflow-auto text-[12.5px] leading-relaxed whitespace-pre-wrap break-words italic">
              {step.thoughts}
            </p>
          </div>
        </div>
      )}
      {step.text && (
        <div className="flex gap-2">
          <MessageSquareText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span className="sr-only">Response: </span>
            <pre className="max-h-72 overflow-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">
              {step.text}
            </pre>
          </div>
        </div>
      )}
      {step.toolCalls.map((call, index) => (
        <p key={index} className="flex items-start gap-2 text-[12.5px]">
          <Wrench aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">{describeToolCall(call)}</span>
        </p>
      ))}
      {!step.thoughts && !step.text && step.toolCalls.length === 0 && (
        <p className="text-[12px] text-muted-foreground">The model returned nothing usable on this step.</p>
      )}
    </li>
  );
}

const CHANGE_TONE = {
  added: "done",
  modified: "info",
  deleted: "danger",
} as const;

function FileDiff({ file }: { file: AgentHistoryDetail["changes"]["changedFiles"][number] }) {
  return (
    <details className="group/file overflow-hidden rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/file:rotate-90"
        />
        <Path className="min-w-0 border-0 bg-transparent px-0">{file.path}</Path>
        <Badge tone={CHANGE_TONE[file.changeKind]} size="sm" className="ml-auto shrink-0">
          {file.changeKind}
        </Badge>
      </summary>
      <div className="border-t border-border">
        <DiffView diff={file.diff} />
      </div>
    </details>
  );
}

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

const TOOL_NAME: Record<string, string> = {
  read_file: "Reading the file",
  read_material: "Reading the material",
  propose_changes: "Saving the changes",
  ask_question: "Asking the question",
  finish_assignment: "Finishing",
};

const asText = (value: unknown) => (typeof value === "string" ? value : null);

/** Tool arguments in words. Values are generated and clipped; shown as text only. */
export function describeToolCall(call: { name: string; arguments: Record<string, unknown> }): string {
  const args = call.arguments;
  switch (call.name) {
    case "read_file": {
      const source = asText(args.source);
      const where = source === "approved" ? "approved" : source === "draft" ? "shared draft"
        : source === "saved" ? "saved output" : source === "worker" ? "working copy" : null;
      return `Read ${asText(args.path) ?? "a file"}${where ? ` (${where})` : ""}`;
    }
    case "read_material":
      return "Read a selected material";
    case "propose_changes": {
      const changes = Array.isArray(args.changes) ? args.changes : [];
      const paths = changes
        .map((change) => (change && typeof change === "object" ? asText((change as Record<string, unknown>).path) : null))
        .filter((path): path is string => !!path);
      return paths.length
        ? `Proposed changes to ${paths.join(", ")}`
        : "Proposed changes";
    }
    case "ask_question":
      return `Asked: “${asText(args.body) ?? "a question"}”`;
    case "finish_assignment":
      return "Finished the assignment";
    default:
      return `Used ${call.name}`;
  }
}

const OUTCOME_TITLE: Partial<Record<AgentHistoryEntry["status"], string>> = {
  failed: "This agent failed",
  timed_out: "This agent ran out of time",
  token_exhausted: "This agent used its whole token budget",
  canceled: "This agent was stopped",
  interrupted: "This agent was interrupted",
};

/** Failure codes are server vocabulary; the copy is this file's. */
function failureText(code: string | null): string {
  switch (code) {
    case null:
      return "Any changes it saved before stopping are shown below.";
    case "blocked_response":
      return "The model declined to respond. Any changes it saved before stopping are shown below.";
    case "provider_rate_limited":
    case "rate_limited":
      return "The model provider was too busy to continue in time. Any saved changes are shown below.";
    default:
      return `It stopped with the reason “${code.replace(/_/g, " ")}”. Any changes it saved before stopping are shown below.`;
  }
}

function toolErrorText(code: string | null): string {
  switch (code) {
    case "FILE_VERSION_CHANGED":
      return "the file had changed since it was read";
    case "scope_violation":
      return "that was outside its assigned files";
    case "invalid_tool_arguments":
      return "the request was malformed";
    case null:
      return "no reason recorded";
    default:
      return code.replace(/_/g, " ").toLowerCase();
  }
}
