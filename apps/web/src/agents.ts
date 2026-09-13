import { ApiError, type AssignmentProgress, type SavedOutputOption, type TaskAttempt, type TaskEvent, type TaskSummary } from '@app/contracts';
import { readEventPages } from './task-polling';
import type { WorkspaceApi } from './workspace-api';

export type AgentTask = {
  task: TaskSummary;
  attempts: TaskAttempt[];
  events: TaskEvent[];
  outputs: SavedOutputOption[];
  errors: string[];
};

/** Bound fan-out across tasks. Each read retains the existing workspace checks.
 * A failed task never hides healthy tasks, or presents old agent state as live. */
export async function readWorkspaceAgents(api: WorkspaceApi, workspaceId: string,
  previous: AgentTask[], signal: AbortSignal): Promise<AgentTask[]> {
  const tasks = await api.listAllTasks(workspaceId, signal);
  const cache = new Map(previous.map((row) => [row.task.id, row.events]));
  const rows: AgentTask[] = new Array(tasks.length);
  let index = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (index < tasks.length && !signal.aborted) {
      const position = index++;
      const task = tasks[position]!;
      const [agents, activity, outputs] = await Promise.allSettled([
        api.listTaskAgents(workspaceId, task.id, signal),
        readEventPages(api, workspaceId, task.id, cache.get(task.id) ?? [], signal),
        api.listSavedOutputs(workspaceId, task.id, signal),
      ]);
      signal.throwIfAborted();
      // Revoked/missing access is never replaced by cached data.
      for (const result of [agents, activity, outputs]) {
        if (result.status === 'rejected' && result.reason instanceof ApiError &&
          result.reason.code === 'WORKSPACE_NOT_FOUND') throw result.reason;
      }
      rows[position] = {
        task,
        attempts: agents.status === 'fulfilled' ? agents.value : [],
        events: activity.status === 'fulfilled' ? activity.value : [],
        outputs: outputs.status === 'fulfilled' ? outputs.value : [],
        errors: [agents.status === 'rejected' ? 'Agent status' : '',
          activity.status === 'rejected' ? 'Activity' : '', outputs.status === 'rejected' ? 'Saved outputs' : ''].filter(Boolean),
      };
    }
  }));
  signal.throwIfAborted();
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
  return rows;
}

/** Question-answer events name the question, not the agent. Never attribute a
 * peer's event (or an older attempt of the same logical agent) to this instance. */
export function eventsForAgent(events: TaskEvent[], agent: AssignmentProgress): TaskEvent[] {
  const sameRun = events.filter((event) => event.taskId === agent.taskId && event.runId === agent.runId);
  const questions = new Set(sameRun.filter((event) => event.payload.agentId === agent.id &&
    typeof event.payload.questionId === 'string').map((event) => event.payload.questionId));
  return sameRun.filter((event) => event.payload.agentId === agent.id ||
    (event.type === 'agent.question_answered' && questions.has(event.payload.questionId)));
}

export function agentOutputPaths(agent: AssignmentProgress, events: TaskEvent[], saved: SavedOutputOption[]) {
  const paths = new Map<string, 'Saved output' | 'Checkpoint'>();
  for (const event of events) {
    if (event.type !== 'agent.checkpointed' || !Array.isArray(event.payload.changedPaths)) continue;
    for (const path of event.payload.changedPaths) {
      if (typeof path === 'string' && agent.writePaths.includes(path)) paths.set(path, 'Checkpoint');
    }
  }
  for (const output of saved) {
    if (output.agentInstanceId === agent.id && output.runId === agent.runId)
      paths.set(output.path, 'Saved output');
  }
  return [...paths].map(([path, kind]) => ({ path, kind }));
}

export function activityLabel(event: TaskEvent): string {
  switch (event.type) {
    case 'agent.started': return 'Started work';
    case 'agent.waiting': return event.payload.reason === 'provider_backoff'
      ? event.payload.waiting === false ? 'Provider wait ended' : 'Waiting for the provider'
      : typeof event.payload.questionId === 'string' ? 'Asked a question' : 'Waiting';
    case 'agent.question_answered': return 'Question answered';
    case 'agent.completed': return 'Completed work';
    case 'agent.failed': return 'Failed';
    case 'agent.checkpointed': return 'Saved a checkpoint';
    case 'agent.timed_out': return 'Timed out';
    case 'agent.token_exhausted': return 'Token budget exhausted';
    default: return 'Activity recorded';
  }
}
