import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { ApiError, isActiveRunStatus, savedOutputSchema, type RetryTaskRequest, type SavedOutput, type SavedOutputOption } from '@app/contracts';
import type { Db } from '../db/client.js';
import type { Database } from '../db/types.js';
import { validatePlan } from './validate-plan.js';

/** Only checkpoint receipts issue selectable output paths. Scopes alone do not
 * prove a file was written. Retain partial checkpoints from failed workers. */
export async function savedOutputs(db: Db | Transaction<Database>, workspaceId: string, taskId: string): Promise<SavedOutputOption[]> {
  const agents = await db.selectFrom('agent_instances as a').innerJoin('runs as r', 'r.id', 'a.run_id')
    .select(['a.id', 'a.run_id', 'a.result_sha', 'a.write_paths', 'a.status', 'r.status as run_status'])
    .where('a.workspace_id', '=', workspaceId).where('a.task_id', '=', taskId).where('a.result_sha', 'is not', null).execute();
  const events = await db.selectFrom('task_events').select(['event_key', 'payload']).where('workspace_id', '=', workspaceId)
    .where('task_id', '=', taskId).where('type', '=', 'agent.checkpointed').execute();
  return agents.filter((a) => !isActiveRunStatus(a.run_status) && !['pending', 'running', 'needs_input'].includes(a.status))
    .flatMap((a) => {
      const paths = new Set(events.filter((e) => e.event_key.startsWith(`agent:${a.id}:checkpoint:`))
        .flatMap((e) => Array.isArray(e.payload.changedPaths) ? e.payload.changedPaths.filter((p): p is string => typeof p === 'string') : []));
      return [...paths].filter((p) => a.write_paths.includes(p)).sort().map((path) => ({
        agentInstanceId: a.id, runId: a.run_id, commitSha: a.result_sha!, path,
      }));
    });
}

/** Invoked inside B03's existing Start transaction while the task is locked. */
export async function prepareRetry(trx: Transaction<Database>, workspaceId: string, taskId: string, input: RetryTaskRequest) {
  const previous = await trx.selectFrom('runs').select(['id', 'status']).where('workspace_id', '=', workspaceId)
    .where('task_id', '=', taskId).orderBy('attempt', 'desc').executeTakeFirst();
  if (!previous || isActiveRunStatus(previous.status)) throw new ApiError('INVALID_STATE', 'Retry requires a finished attempt.');
  const available = await savedOutputs(trx, workspaceId, taskId);
  const selected: SavedOutput[] = [];
  for (const selection of input.savedOutputs) {
    const output = available.find((o) => o.agentInstanceId === selection.agentInstanceId && o.path === selection.path);
    if (!output || selected.some((s) => s.agentInstanceId === output.agentInstanceId && s.path === output.path)) {
      throw new ApiError('VALIDATION_FAILED', 'Select each saved checkpoint file once from this task.');
    }
    selected.push({ ...output, id: randomUUID() });
  }
  const plans = await trx.selectFrom('task_events').select('payload').where('task_id', '=', taskId)
    .where('workspace_id', '=', workspaceId).where('type', '=', 'agent.completed').orderBy('id', 'desc').execute();
  const prior = plans.find((e) => e.payload.plan !== undefined);
  const checked = prior ? validatePlan(prior.payload.plan) : undefined;
  if (checked && !checked.valid) throw new ApiError('INVALID_STATE', 'The saved assignment plan is invalid.');
  return { sourceRunId: previous.id, savedOutputs: selected, ...(checked?.valid ? { plan: checked.plan } : {}) };
}

export async function readRetry(db: Db, runId: string) {
  const event = await db.selectFrom('task_events').select('payload').where('run_id', '=', runId)
    .where('event_key', '=', `run:${runId}:started`).executeTakeFirst();
  const retry = event?.payload.retry as { sourceRunId: string; savedOutputs: unknown[]; plan?: unknown } | undefined;
  if (!retry) return undefined;
  const plan = retry.plan === undefined ? undefined : validatePlan(retry.plan);
  if (plan && !plan.valid) throw new ApiError('INVALID_STATE', 'The saved assignment plan is invalid.');
  return { sourceRunId: retry.sourceRunId, savedOutputs: retry.savedOutputs.map((s) => savedOutputSchema.parse(s)),
    plan: plan?.valid ? plan.plan : undefined };
}
