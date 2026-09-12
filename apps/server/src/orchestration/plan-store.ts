import { isDeepStrictEqual } from 'node:util';
import {
  ACTIVE_RUN_STATUSES, ORCHESTRATOR_AGENT_KEY, contextManifestSchema, eventKeys,
  type AgentPlan, type PlanningContext, type ContextManifest,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import { PgAgentLedger } from '../agents/ledger.js';
import { appendEvent } from '../events/service.js';
import { validatePlan } from './validate-plan.js';

export class PlanningError extends Error {
  override readonly name = 'PlanningError';
  constructor(readonly code: 'context_mismatch' | 'snapshot_not_ready' | 'invalid_plan' | 'blocked_response' |
    'unexpected_tools' | 'stored_plan_invalid' | 'planning_conflict') { super(`Planning refused (${code}).`); }
}

/** Durable plan artifact in the existing completion event, committed together
 * with planning completion. Worker instantiation/dispatch belongs to C05/C06.
 */
export class PgPlanStore {
  constructor(private readonly deps: { db: Db; ledger: PgAgentLedger; bootId: string; now?: () => Date }) {}

  async assertContext(runId: string, agentInstanceId: string, context: PlanningContext): Promise<string> {
    const run = await this.deps.db.selectFrom('runs as r').innerJoin('tasks as t', 't.id', 'r.task_id')
      .innerJoin('agent_instances as a', 'a.run_id', 'r.id')
      .select(['r.id', 'r.task_id', 'r.task_version', 'r.guidance_version', 'r.discussion_cutoff_seq',
        'r.input_snapshot_sha', 'r.context_manifest'])
      .where('r.id', '=', runId).where('a.id', '=', agentInstanceId)
      .where('r.status', 'in', ACTIVE_RUN_STATUSES).whereRef('t.active_run_id', '=', 'r.id')
      .where('r.boot_id', '=', this.deps.bootId).where('a.boot_id', '=', this.deps.bootId)
      .where('a.preset', '=', 'orchestrator').where('a.agent_key', '=', ORCHESTRATOR_AGENT_KEY)
      .executeTakeFirst();
    if (!run) throw new PlanningError('context_mismatch');
    if (!run.input_snapshot_sha || !run.context_manifest) throw new PlanningError('snapshot_not_ready');
    if (context.task.id !== run.task_id || context.task.version !== run.task_version ||
        context.manifest.taskVersion !== run.task_version || context.manifest.guidanceVersion !== run.guidance_version ||
        context.manifest.discussionCutoffSeq !== run.discussion_cutoff_seq ||
        !isDeepStrictEqual(context.manifest, contextManifestSchema.parse(run.context_manifest))) {
      throw new PlanningError('context_mismatch');
    }
    return run.input_snapshot_sha;
  }

  async read(agentInstanceId: string, contextDigest: string, inputSnapshotSha: string): Promise<AgentPlan | null> {
    const row = await this.deps.db.selectFrom('task_events as e')
      .innerJoin('agent_instances as a', 'a.run_id', 'e.run_id')
      .select('e.payload').where('a.id', '=', agentInstanceId).where('a.status', '=', 'completed')
      .where('e.event_key', '=', eventKeys.agentSettled(agentInstanceId, 'completed')).executeTakeFirst();
    if (!row) return null;
    if (row.payload.contextDigest !== contextDigest || row.payload.inputSnapshotSha !== inputSnapshotSha) throw new PlanningError('context_mismatch');
    const validated = validatePlan(row.payload.plan);
    if (!validated.valid) throw new PlanningError('stored_plan_invalid');
    return validated.plan;
  }

  async save(agentInstanceId: string, runId: string, contextDigest: string, value: unknown,
    snapshot: { inputSnapshotSha: string; manifest: ContextManifest }, signal?: AbortSignal): Promise<AgentPlan> {
    const validated = validatePlan(value);
    if (!validated.valid) throw new PlanningError('invalid_plan');
    return this.deps.ledger.withActiveWrite(agentInstanceId, async (trx, agent) => {
      signal?.throwIfAborted();
      if (agent.run_id !== runId || agent.preset !== 'orchestrator' || agent.agent_key !== ORCHESTRATOR_AGENT_KEY) {
        throw new PlanningError('context_mismatch');
      }
      // The ledger holds the run lock. Recheck capture identity in the same
      // transaction as completion, not merely before the model request.
      const run = await trx.selectFrom('runs').select(['input_snapshot_sha', 'context_manifest'])
        .where('id', '=', runId).executeTakeFirstOrThrow();
      if (run.input_snapshot_sha !== snapshot.inputSnapshotSha ||
          !isDeepStrictEqual(contextManifestSchema.parse(run.context_manifest), snapshot.manifest)) {
        throw new PlanningError('context_mismatch');
      }
      const existing = await trx.selectFrom('task_events').select('id').where('task_id', '=', agent.task_id)
        .where('event_key', '=', eventKeys.agentSettled(agent.id, 'completed')).executeTakeFirst();
      if (existing) throw new PlanningError('planning_conflict');
      await appendEvent(trx, {
        workspaceId: agent.workspace_id, taskId: agent.task_id, runId,
        eventKey: eventKeys.agentSettled(agent.id, 'completed'), type: 'agent.completed',
        payload: { agentId: agent.id, contextDigest, inputSnapshotSha: snapshot.inputSnapshotSha, plan: validated.plan },
      });
      await trx.updateTable('agent_instances').set({ status: 'completed', ended_at: this.deps.now?.() ?? new Date() })
        .where('id', '=', agent.id).execute();
      signal?.throwIfAborted();
      return validated.plan;
    });
  }

  async fail(agentInstanceId: string, code: string): Promise<void> {
    await this.deps.ledger.withActiveWrite(agentInstanceId, async (trx, agent) => {
      const now = this.deps.now?.() ?? new Date();
      await trx.updateTable('agent_instances').set({ status: 'failed', ended_at: now }).where('id', '=', agent.id).execute();
      await trx.updateTable('tasks').set({ status: 'incomplete', updated_at: now })
        .where('id', '=', agent.task_id).where('active_run_id', '=', agent.run_id).execute();
      await appendEvent(trx, { workspaceId: agent.workspace_id, taskId: agent.task_id, runId: agent.run_id,
        eventKey: eventKeys.agentSettled(agent.id, 'failed'), type: 'agent.failed', payload: { agentId: agent.id, code } });
    });
  }
}
