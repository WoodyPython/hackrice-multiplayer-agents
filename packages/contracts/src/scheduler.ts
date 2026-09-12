import type { PlanningContext } from './run.js';

export type AssignmentOutcome =
  | { status: 'integrated'; resultSha: string }
  | { status: 'conflict'; paths: string[] }
  | { status: 'pending_integration' | 'failed' | 'blocked' | 'canceled' };

export interface ScheduleResult {
  runId: string;
  resultSha: string;
  assignments: Record<string, AssignmentOutcome>;
}

export interface AssignmentSchedulingService {
  schedule(input: { runId: string; planningInstanceId: string; context: PlanningContext }): Promise<ScheduleResult>;
  /** Local abort only; C06 also cancels the durable run. */
  cancel(runId: string): void;
}

export type IntegrationCandidate =
  | { status: 'integrated'; resultSha: string }
  | { status: 'conflict'; paths: string[] };

/** D05 invokes this under its workspace Git lock, after preparation and before
 * ref publication. C05 locks task/run/agent, verifies the completed result and
 * expected result head, then publishes and records the receipt. No outer DB
 * transaction may be held while entering Git. */
export type ResultIntegrationGuard = (candidate: IntegrationCandidate, publish: () => Promise<void>) => Promise<void>;

export interface WorkerResultIntegrationService {
  /** Never publish without awaiting guard. Conflicts leave the result ref intact.
   * Validate scope/delta against the stored base, and CAS expectedResultSha.
   * No main/human changes. No automatic replay following a partial publication. */
  integrate(input: {
    workspaceId: string; runId: string; agentInstanceId: string;
    baseSha: string; workerResultSha: string; expectedResultSha: string; writePaths: string[];
  }, guard: ResultIntegrationGuard): Promise<'handled' | 'unavailable'>;
}

/** Separate Git capability so the coordinator cannot mistake the legacy
 * unguarded integrate method for a publication guard. */
export interface GuardedResultIntegrationService {
  integrateGuarded(input: Parameters<WorkerResultIntegrationService['integrate']>[0],
    guard: ResultIntegrationGuard): Promise<'handled'>;
}

/** Isolated consumers without D05 retain checkpoints without claiming integration. */
export class NullWorkerResultIntegrationService implements WorkerResultIntegrationService {
  readonly calls: Array<Parameters<WorkerResultIntegrationService['integrate']>[0]> = [];
  async integrate(input: Parameters<WorkerResultIntegrationService['integrate']>[0]): Promise<'unavailable'> {
    this.calls.push(structuredClone(input));
    return 'unavailable';
  }
}
