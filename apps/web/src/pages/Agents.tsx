import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, RefreshCw } from 'lucide-react';
import { AGENT_STATUSES, isActiveRunStatus, type AssignmentProgress, type TaskAttempt } from '@app/contracts';
import { useBrowser } from '../browser-context';
import { activityLabel, agentOutputPaths, eventsForAgent, readWorkspaceAgents, type AgentTask } from '../agents';
import { humanizeStatus, toneFor } from '../board';
import { refreshLoop } from '../realtime';
import { EmptyState } from '../components/EmptyState';
import { PageHeading } from '../components/PageHeading';
import { Badge, Dot } from '../components/ui/badge';
import { Button, ButtonLink } from '../components/ui/button';
import { Label, Select } from '../components/ui/field';
import { Notice, Path, Skeleton } from '../components/ui/misc';

export function Agents({ workspaceId }: { workspaceId: string }) {
  const { api } = useBrowser();
  const [rows, setRows] = useState<AgentTask[] | null>(null);
  const [failure, setFailure] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);
  const [params, setParams] = useSearchParams();
  const filter = AGENT_STATUSES.find((status) => status === params.get('status')) ?? 'all';

  useEffect(() => {
    const controller = new AbortController();
    let cache: AgentTask[] = [];
    let active = false;
    setRows(null);
    setUpdatedAt(null);
    setFailure(false);
    const pull = async () => {
      setRefreshing(true);
      try {
        const next = await readWorkspaceAgents(api, workspaceId, cache, controller.signal);
        if (controller.signal.aborted) return;
        cache = next;
        active = next.some((row) => row.errors.length || row.attempts.some((run) => isActiveRunStatus(run.status)));
        setRows(next);
        setUpdatedAt(new Date());
        setFailure(false);
      } catch {
        if (controller.signal.aborted) return;
        // Hide unverified status, including on loss of workspace access.
        setRows(null);
        setFailure(true);
        active = true;
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
    };
    const stop = refreshLoop(workspaceId, undefined, pull, () => active ? 5000 : 15000);
    return () => { controller.abort(); stop(); };
  }, [api, workspaceId, nonce]);

  const attempts = (rows ?? []).flatMap((row) => row.attempts.map((attempt) => ({ row, attempt })))
    .sort((a, b) => b.attempt.createdAt.localeCompare(a.attempt.createdAt) || b.attempt.attempt - a.attempt.attempt);
  const visible = attempts.map(({ row, attempt }) => ({ row, attempt,
    agents: attempt.assignments.filter((agent) => filter === 'all' || agent.status === filter),
    // The task listing can predate a newly started run; the run's own status wins.
    active: isActiveRunStatus(attempt.status),
  })).filter(({ agents, attempt }) => agents.length || (filter === 'all' && !attempt.assignments.length));
  const errors = rows?.filter((row) => row.errors.length) ?? [];

  return <>
    <PageHeading eyebrow="Across your workspace" title="Agents"
      description="Follow each agent’s work, from its current run to earlier attempts."
      actions={<Button onClick={() => setNonce((value) => value + 1)} disabled={refreshing}>
        <RefreshCw aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh'}
      </Button>} />
    {failure ? <Notice role="alert" tone="warn" title="Could not load agents">
      <p>Check your connection and workspace access, then try again.</p>
      <Button onClick={() => setNonce((value) => value + 1)} disabled={refreshing}>Try again</Button>
    </Notice> : rows === null ? <div aria-busy="true" className="space-y-3">
      <p role="status" className="sr-only">Loading agents…</p>
      <Skeleton aria-hidden="true" className="h-36" /><Skeleton aria-hidden="true" className="h-36" />
    </div> : <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="w-full space-y-2 sm:w-56">
          <Label htmlFor="agent-status">Agent status</Label>
          <Select id="agent-status" value={filter} onChange={(event) => {
            const next = new URLSearchParams(params);
            if (event.target.value === 'all') next.delete('status'); else next.set('status', event.target.value);
            setParams(next);
          }}>
            <option value="all">All statuses</option>
            {AGENT_STATUSES.map((status) => <option key={status} value={status}>{humanizeStatus(status)}</option>)}
          </Select>
        </div>
        <p className="text-xs text-muted-foreground" role="status">
          {refreshing ? 'Refreshing…' : `${errors.length ? 'Partially updated' : 'Updated'} ${updatedAt?.toLocaleTimeString() ?? ''} · Updates automatically`}
        </p>
      </div>
      {errors.length > 0 && <Notice role="alert" tone="warn" className="mb-6" title="Some agent information is unavailable">
        <ul className="space-y-1">{errors.map(({ task, errors: missing }) => <li key={task.id}>
          <Link className="underline underline-offset-2" to={`/w/${workspaceId}/tasks/${task.id}?tab=Agents&from=agents`}>{task.title}</Link>
          {`: ${missing.join(', ')} could not be loaded.`}
        </li>)}</ul>
        <Button size="sm" onClick={() => setNonce((value) => value + 1)} disabled={refreshing}>Try again</Button>
      </Notice>}
      {!attempts.length && !errors.length ? <EmptyState icon={Bot} title="No agents yet"
        action={<ButtonLink to={`/w/${workspaceId}`}>View tasks</ButtonLink>}>
        Agents appear here when a task starts an attempt.
      </EmptyState> : !visible.length && !errors.length ? <EmptyState icon={Bot} title="No agents match this status">
        Choose another status to see more agents.
      </EmptyState> : <div className="space-y-8">
        {[true, false].map((active) => <section key={String(active)} aria-label={active ? 'Active runs' : 'Past attempts'}>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            {active ? 'Active runs' : 'Past attempts'}
            <Badge size="sm">{visible.filter((item) => item.active === active).length}</Badge>
          </h2>
          <div className="space-y-4">{visible.filter((item) => item.active === active).map(({ row, attempt, agents }) =>
            <Attempt key={attempt.runId} row={row} attempt={attempt} agents={agents} active={active} workspaceId={workspaceId} />)}
            {!visible.some((item) => item.active === active) && <p className="rounded-xl border border-dashed border-border p-5 text-[13px] text-muted-foreground">
              {filter === 'all' ? active ? 'No active runs.' : 'No past attempts.' : 'No matching agents in this section.'}
            </p>}
          </div>
        </section>)}
      </div>}
    </>}
  </>;
}

function Attempt({ row, attempt, agents, active, workspaceId }: {
  row: AgentTask; attempt: TaskAttempt; agents: AssignmentProgress[]; active: boolean; workspaceId: string;
}) {
  const taskUrl = `/w/${workspaceId}/tasks/${row.task.id}`;
  return <article aria-label={`${row.task.title}, attempt ${attempt.attempt}`} className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/40 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link className="text-sm font-semibold break-words underline-offset-2 hover:underline" to={`${taskUrl}?tab=Agents&from=agents`}>{row.task.title}</Link>
        <p className="mt-1 text-xs text-muted-foreground">Attempt {attempt.attempt} · Task version {attempt.taskVersion}
          {' · '}{attempt.endedAt ? 'Ended ' : 'Created '}<Timestamp value={attempt.endedAt ?? attempt.createdAt} />
        </p>
      </div>
      <Badge tone={toneFor(attempt.status)} size="sm"><Dot tone={toneFor(attempt.status)} live={active} />Run: {humanizeStatus(attempt.status)}</Badge>
    </header>
    {!agents.length ? <p className="p-4 text-[13px] text-muted-foreground">
      {active ? 'No agents have been assigned yet.' : 'This attempt ended without agent assignments.'}
    </p> : <ul className="divide-y divide-border">{agents.map((agent) => <Agent key={agent.id}
      agent={agent} row={row} active={active} taskUrl={taskUrl} />)}</ul>}
  </article>;
}

function Agent({ agent, row, active, taskUrl }: { agent: AssignmentProgress; row: AgentTask; active: boolean; taskUrl: string }) {
  const events = eventsForAgent(row.events, agent);
  const paths = agentOutputPaths(agent, events, row.outputs);
  const result = [...events].reverse().find((event) => event.type === 'agent.completed')?.payload.result;
  const summary = result && typeof result === 'object' && 'summary' in result && typeof result.summary === 'string'
    ? result.summary.slice(0, 20000) : null;
  return <li className="grid min-w-0 gap-5 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Bot aria-hidden="true" className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold break-all">{agent.assignmentKey}</h3>
        <Badge size="sm">{agent.preset}</Badge>
        <Badge size="sm" tone={toneFor(agent.status)}><Dot tone={toneFor(agent.status)} live={active && agent.status === 'running'} />{humanizeStatus(agent.status)}</Badge>
      </div>
      <p className="mt-2 text-[13px] break-words text-muted-foreground">{agent.instructionSummary}</p>
      <p className="mt-2 text-xs text-muted-foreground">{agent.endedAt ? <>Ended <Timestamp value={agent.endedAt} /></>
        : agent.startedAt ? <>Started <Timestamp value={agent.startedAt} /></> : 'Not started'}</p>
      {agent.writePaths.length > 0 && <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer py-1">Assigned paths ({agent.writePaths.length})</summary>
        <ul className="mt-2 space-y-2">{agent.writePaths.map((path) => <li key={path}><Path>{path}</Path></li>)}</ul>
      </details>}
      {active && agent.status === 'needs_input' && <ButtonLink size="sm" className="mt-3" to={`${taskUrl}?tab=Discussion&from=agents`}>View discussion</ButtonLink>}
    </div>
    <div className="min-w-0 space-y-4">
      <div>
        <h4 className="mb-2 text-xs font-semibold">Recent activity</h4>
        {row.errors.includes('Activity') ? <p className="text-xs text-muted-foreground">Activity unavailable.</p>
          : events.length ? <ol className="space-y-1.5 text-xs text-muted-foreground">{events.slice(-3).reverse().map((event) => <li key={event.id}>
            {activityLabel(event)} · <Timestamp value={event.createdAt} />
          </li>)}</ol> : <p className="text-xs text-muted-foreground">No recorded activity for this agent.</p>}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold">Available outputs</h4>
        {row.errors.includes('Saved outputs') && <p className="mb-2 text-xs text-muted-foreground">Saved output listing unavailable.</p>}
        {paths.length > 0 && <ul className="space-y-2">{paths.map(({ path, kind }) => <li key={path} className="text-xs text-muted-foreground">
          <Path>{path}</Path> <span>{kind}</span>
        </li>)}</ul>}
        {summary && <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer py-1 font-medium">Read result summary</summary>
          <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">{summary}</p>
        </details>}
        {!paths.length && !summary && <p className="text-xs text-muted-foreground">
          {row.errors.length ? 'Outputs could not be fully checked.' : 'No saved output recorded.'}
        </p>}
      </div>
    </div>
  </li>;
}

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}
