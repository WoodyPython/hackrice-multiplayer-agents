import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Transaction } from 'kysely';
import { eventKeys, isActiveRunStatus, repoPathSchema, shaSchema,
  type AssignmentOutcome, type PlanningContext, type IntegrationCandidate } from '@app/contracts';
import type { Db } from '../db/client.js';
import type { Database, RunRow } from '../db/types.js';
import { appendEvent } from '../events/service.js';
import { PgPlanStore, PlanningError } from './plan-store.js';
import type { PgAgentLedger } from '../agents/ledger.js';

export class SchedulingError extends Error {
  constructor(readonly code: 'inactive' | 'already_scheduled' | 'invalid_integration' | 'invalid_assignment') {
    super(`Scheduling refused (${code}).`);
  }
}

/** All metadata writes use task -> run -> agent order. Git enters the guarded
 * receipt callback while holding its own workspace lock, never the reverse. */
export class PgSchedulerStore {
  constructor(private readonly deps: { db: Db; bootId: string; ledger: PgAgentLedger }) {}

  async active<T>(runId: string, signal: AbortSignal,
    work: (trx: Transaction<Database>, run: RunRow) => Promise<T>): Promise<T> {
    return this.deps.db.transaction().execute(async (trx) => {
      signal.throwIfAborted();
      const seed = await trx.selectFrom('runs').select('task_id').where('id', '=', runId).executeTakeFirst();
      if (!seed) throw new SchedulingError('inactive');
      const task = await trx.selectFrom('tasks').select('active_run_id').where('id', '=', seed.task_id).forUpdate().executeTakeFirstOrThrow();
      const run = await trx.selectFrom('runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      if (task.active_run_id !== runId || run.boot_id !== this.deps.bootId || !isActiveRunStatus(run.status)) {
        throw new SchedulingError('inactive');
      }
      signal.throwIfAborted();
      const value = await work(trx, run);
      signal.throwIfAborted();
      return value;
    });
  }

  async claim(runId: string, planningInstanceId: string, context: PlanningContext, signal: AbortSignal) {
    const plans = new PgPlanStore(this.deps);
    const snapshot = await plans.assertContext(runId, planningInstanceId, context);
    const digest = createHash('sha256').update(JSON.stringify(context)).digest('hex');
    const plan = await plans.read(planningInstanceId, digest, snapshot);
    if (!plan) throw new PlanningError('stored_plan_invalid');
    const run = await this.active(runId, signal, async (trx, run) => {
      if (run.input_snapshot_sha !== snapshot || !isDeepStrictEqual(run.context_manifest, context.manifest)) {
        throw new PlanningError('context_mismatch');
      }
      const previous = await trx.selectFrom('task_events').select('id').where('run_id', '=', runId)
        .where('event_key', '=', `run:${runId}:scheduler`).executeTakeFirst();
      const worker = await trx.selectFrom('agent_instances').select('id').where('run_id', '=', runId)
        .where('preset', '!=', 'orchestrator').executeTakeFirst();
      if (previous || worker || run.result_head_sha) throw new SchedulingError('already_scheduled');
      await appendEvent(trx, { workspaceId: run.workspace_id, taskId: run.task_id, runId,
        eventKey: `run:${runId}:scheduler`, type: 'agent.waiting',
        payload: { reason: 'preparing_assignments', planningInstanceId } });
      return run;
    });
    return { run, plan, snapshot };
  }

  async initialize(runId: string, head: string, signal: AbortSignal) {
    await this.active(runId, signal, async (trx, run) => {
      await trx.updateTable('runs').set({ result_head_sha: head, status: 'working' }).where('id', '=', runId).execute();
      await trx.updateTable('tasks').set({ status: 'working', updated_at: new Date() }).where('id', '=', run.task_id).execute();
    });
  }

  async base(runId: string, id: string, signal: AbortSignal) {
    return this.active(runId, signal, async (trx, run) => {
      const agent = await trx.selectFrom('agent_instances').selectAll().where('id', '=', id).where('run_id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      if (agent.status !== 'pending' || agent.boot_id !== this.deps.bootId || agent.base_sha || !run.result_head_sha) {
        throw new SchedulingError('invalid_assignment');
      }
      const dependencies = await trx.selectFrom('agent_dependencies').select('prerequisite_agent_id').where('agent_id', '=', id).execute();
      for (const dep of dependencies) {
        const receipt = await trx.selectFrom('task_events').select('payload').where('run_id', '=', runId)
          .where('event_key', '=', `agent:${dep.prerequisite_agent_id}:integration`).executeTakeFirst();
        if (receipt?.payload.status !== 'integrated') throw new SchedulingError('invalid_assignment');
      }
      await trx.updateTable('agent_instances').set({ base_sha: run.result_head_sha }).where('id', '=', id).execute();
      return { ...agent, base_sha: run.result_head_sha };
    });
  }

  async completed(runId: string, id: string, signal: AbortSignal) {
    return this.active(runId, signal, async (trx, run) => {
      const agent = await trx.selectFrom('agent_instances').selectAll().where('id', '=', id).where('run_id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      const receipt = await trx.selectFrom('task_events').select('id').where('run_id', '=', runId)
        .where('event_key', '=', eventKeys.agentSettled(id, 'completed')).executeTakeFirst();
      if (agent.status !== 'completed' || agent.boot_id !== this.deps.bootId || !agent.result_sha || !agent.base_sha || !run.result_head_sha || !receipt) {
        throw new SchedulingError('invalid_assignment');
      }
      return { workspaceId: run.workspace_id, runId, agentInstanceId: id, baseSha: agent.base_sha,
        workerResultSha: agent.result_sha, expectedResultSha: run.result_head_sha, writePaths: agent.write_paths };
    });
  }

  async integrate(input: Awaited<ReturnType<PgSchedulerStore['completed']>>, candidate: IntegrationCandidate,
    publish: () => Promise<void>, signal: AbortSignal) {
    // D05 is trusted backend code, but malformed receipts must never unlock dependents.
    if (candidate.status === 'integrated') shaSchema.parse(candidate.resultSha);
    else if (candidate.status === 'conflict' && candidate.paths.length > 0) candidate.paths.forEach((p) => repoPathSchema.parse(p));
    else throw new SchedulingError('invalid_integration');
    await this.active(input.runId, signal, async (trx, run) => {
      const agent = await trx.selectFrom('agent_instances').selectAll().where('id', '=', input.agentInstanceId)
        .where('run_id', '=', input.runId).forUpdate().executeTakeFirstOrThrow();
      if (agent.status !== 'completed' || agent.boot_id !== this.deps.bootId || agent.result_sha !== input.workerResultSha ||
          agent.base_sha !== input.baseSha || run.result_head_sha !== input.expectedResultSha) throw new SchedulingError('invalid_integration');
      const prior = await trx.selectFrom('task_events').select('id').where('run_id', '=', run.id)
        .where('event_key', '=', `agent:${agent.id}:integration`).executeTakeFirst();
      if (prior) throw new SchedulingError('invalid_integration');
      signal.throwIfAborted();
      if (candidate.status === 'integrated') {
        await publish();
        await trx.updateTable('runs').set({ result_head_sha: candidate.resultSha }).where('id', '=', run.id).execute();
      } else {
        await trx.updateTable('tasks').set({ status: 'conflict', updated_at: new Date() }).where('id', '=', run.task_id).execute();
      }
      await appendEvent(trx, { workspaceId: run.workspace_id, taskId: run.task_id, runId: run.id,
        eventKey: `agent:${agent.id}:integration`, type: candidate.status === 'integrated' ? 'agent.checkpointed' : 'agent.waiting',
        payload: { agentId: agent.id, phase: 'integration', ...candidate } });
    });
  }

  async outcome(runId: string, id: string, outcome: AssignmentOutcome, signal: AbortSignal) {
    await this.active(runId, signal, async (trx, run) => {
      // Execution failures are usually already terminalized by C02/C04. A setup
      // failure has no execution scope and must terminalize its pending instance.
      if (outcome.status === 'failed') {
        await trx.updateTable('agent_instances').set({ status: 'failed', ended_at: new Date() })
          .where('id', '=', id).where('run_id', '=', runId).where('status', '=', 'pending').execute();
        await trx.updateTable('tasks').set({ status: 'incomplete', updated_at: new Date() }).where('id', '=', run.task_id).execute();
      }
      await appendEvent(trx, { workspaceId: run.workspace_id, taskId: run.task_id, runId,
        eventKey: `agent:${id}:schedule:${outcome.status}`, type: 'agent.waiting',
        payload: { agentId: id, reason: outcome.status, phase: 'scheduler' } });
    });
  }
}
