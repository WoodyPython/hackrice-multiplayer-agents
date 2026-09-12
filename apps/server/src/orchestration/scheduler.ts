import { planningContextSchema, NullWorkerResultIntegrationService,
  type AssignmentOutcome, type AssignmentSchedulingService, type GitService, type ScheduleResult,
  type WorkerExecutionService, type WorkerResultIntegrationService, type GuardedResultIntegrationService } from '@app/contracts';
import type { Db } from '../db/client.js';
import type { PgAgentLedger } from '../agents/ledger.js';
import type { ModelAdapter } from '../models/types.js';
import { PgRunStore } from '../runs/run-store.js';
import { PgSchedulerStore, SchedulingError } from './scheduler-store.js';

interface Deps {
  db: Db; bootId: string; ledger: PgAgentLedger; adapter: Pick<ModelAdapter, 'getModel'>;
  workers: WorkerExecutionService; git: Pick<GitService, 'createResult' | 'createWorker'> & Partial<GuardedResultIntegrationService>;
  integration?: WorkerResultIntegrationService;
}

/** One service per process. Runs/agents have no fixed concurrency ceiling.
 * Only setup/base selection/integration queue by workspace; model calls never
 * occupy that queue. Durable claims reject other coordinators and replay. */
export class ParallelAssignmentScheduler implements AssignmentSchedulingService {
  private readonly store: PgSchedulerStore;
  private readonly runs: PgRunStore;
  private readonly integration: WorkerResultIntegrationService;
  private readonly active = new Map<string, {
    signature: string; promise: Promise<ScheduleResult>; controller: AbortController; agents: Set<string>;
  }>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: Deps) {
    this.store = new PgSchedulerStore(deps);
    this.runs = new PgRunStore(deps);
    this.integration = deps.integration ?? (deps.git.integrateGuarded
      ? { integrate: (input, guard) => deps.git.integrateGuarded!(input, guard) }
      : new NullWorkerResultIntegrationService());
  }

  schedule(input: Parameters<AssignmentSchedulingService['schedule']>[0]): Promise<ScheduleResult> {
    let context;
    try { context = planningContextSchema.parse(structuredClone(input.context)); }
    catch { return Promise.reject(new SchedulingError('invalid_assignment')); }
    const signature = JSON.stringify([input.planningInstanceId, context]);
    const existing = this.active.get(input.runId);
    if (existing) return existing.signature === signature ? existing.promise : Promise.reject(new SchedulingError('already_scheduled'));
    const controller = new AbortController(), agents = new Set<string>();
    const promise = this.run({ ...input, context }, controller.signal, agents)
      .finally(() => this.active.delete(input.runId));
    this.active.set(input.runId, { signature, promise, controller, agents });
    return promise;
  }

  cancel(runId: string): void {
    const current = this.active.get(runId);
    if (!current) return;
    current.controller.abort(new SchedulingError('inactive'));
    for (const id of current.agents) this.deps.workers.cancel(id);
  }

  private serial<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.queues.get(workspaceId) ?? Promise.resolve()).then(action);
    // A failed integration must not poison another task's queue.
    const tail = operation.catch(() => {}).finally(() => {
      if (this.queues.get(workspaceId) === tail) this.queues.delete(workspaceId);
    });
    this.queues.set(workspaceId, tail);
    return operation;
  }

  private async run(input: Parameters<AssignmentSchedulingService['schedule']>[0], signal: AbortSignal, agents: Set<string>): Promise<ScheduleResult> {
    const { runId, context, planningInstanceId } = input;
    const { run, plan, snapshot } = await this.store.claim(runId, planningInstanceId, context, signal);
    const instances = new Map<string, string>();
    for (const assignment of plan.assignments) {
      signal.throwIfAborted();
      const agent = await this.deps.ledger.createInstance({ runId, agentKey: assignment.id, assignmentKey: assignment.id,
        preset: assignment.preset, modelId: this.deps.adapter.getModel(assignment.preset).modelId,
        instruction: assignment.instruction, writePaths: assignment.writePaths });
      instances.set(assignment.id, agent.id);
    }
    await this.runs.linkDependencies(runId, plan);
    await this.serial(run.workspace_id, async () => {
      await this.store.active(runId, signal, async () => {});
      await this.deps.git.createResult({ workspaceId: run.workspace_id, runId, baseSha: snapshot });
      await this.store.initialize(runId, snapshot, signal);
    });

    const outcomes: Record<string, AssignmentOutcome> = Object.create(null);
    const pending = new Set(plan.assignments.map((a) => a.id));
    const jobs = new Map<string, Promise<{ key: string; outcome: AssignmentOutcome }>>();
    try {
      while (pending.size || jobs.size) {
        await this.store.active(runId, signal, async () => {});
        for (const assignment of plan.assignments) {
          if (!pending.has(assignment.id) || !assignment.dependsOn.every((id) => outcomes[id]?.status === 'integrated')) continue;
          pending.delete(assignment.id);
          const id = instances.get(assignment.id)!;
          agents.add(id);
          const job = this.execute(run.workspace_id, runId, id, context, signal)
            .then((outcome) => ({ key: assignment.id, outcome })).finally(() => agents.delete(id));
          jobs.set(assignment.id, job);
        }
        if (!jobs.size) break;
        const finished = await Promise.race(jobs.values());
        jobs.delete(finished.key);
        outcomes[finished.key] = finished.outcome;
      }
      for (const key of pending) {
        outcomes[key] = { status: 'blocked' };
        await this.store.outcome(runId, instances.get(key)!, outcomes[key], signal);
      }
      const resultSha = await this.store.active(runId, signal, async (_trx, current) => current.result_head_sha!);
      return { runId, resultSha, assignments: outcomes };
    } catch (error) {
      for (const id of agents) this.deps.workers.cancel(id);
      await Promise.allSettled(jobs.values());
      throw error;
    }
  }

  private async execute(workspaceId: string, runId: string, id: string,
    context: Parameters<AssignmentSchedulingService['schedule']>[0]['context'], signal: AbortSignal): Promise<AssignmentOutcome> {
    try {
      await this.serial(workspaceId, async () => {
        const agent = await this.store.base(runId, id, signal);
        if (agent.preset === 'writer' || agent.preset === 'coder') {
          await this.deps.git.createWorker({ workspaceId, agentInstanceId: id, baseSha: agent.base_sha });
        }
        await this.store.active(runId, signal, async () => {});
      });
      signal.throwIfAborted();
      await this.deps.workers.execute({ agentInstanceId: id, context });
      return await this.serial(workspaceId, async () => {
        const completed = await this.store.completed(runId, id, signal);
        let accepted: AssignmentOutcome | undefined;
        const guard: Parameters<WorkerResultIntegrationService['integrate']>[1] = async (candidate, publish) => {
          if (accepted) throw new SchedulingError('invalid_integration');
          await this.store.integrate(completed, candidate, publish, signal);
          accepted = structuredClone(candidate);
        };
        // Readonly/no-change workers contribute evidence without Git changes.
        if (completed.workerResultSha === completed.baseSha) {
          await guard({ status: 'integrated', resultSha: completed.expectedResultSha }, async () => {});
        } else {
          const result = await this.integration.integrate(completed, guard);
          if (result === 'unavailable' && !accepted) {
            const outcome = { status: 'pending_integration' } as const;
            await this.store.outcome(runId, id, outcome, signal);
            return outcome;
          }
          if (result !== 'handled' || !accepted) throw new SchedulingError('invalid_integration');
        }
        return accepted!;
      });
    } catch (error) {
      if (signal.aborted) return { status: 'canceled' };
      // Preserve the worker's exact failure/checkpoint record; never serialize
      // provider/OS exception text into task events or model context.
      await this.store.outcome(runId, id, { status: 'failed' }, signal);
      return { status: 'failed' };
    }
  }
}
