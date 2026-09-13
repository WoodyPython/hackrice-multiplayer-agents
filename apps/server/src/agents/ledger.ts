import { type Selectable, type Transaction } from 'kysely';
import {
  AGENT_TIMEOUT_MS, TASK_AGENT_TOKEN_BUDGET, isActiveRunStatus, eventKeys,
  modelUsageSchema, type AgentPreset, type AgentService, type ModelUsage, type TaskAgentBudget,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { AgentInstancesTable, Database, TaskAgentBudgetsTable } from '../db/types.js';
import { appendEvent } from '../events/service.js';
import type { ModelProfile } from '../models/types.js';

type Trx = Transaction<Database>;
type Agent = Selectable<AgentInstancesTable>;
type Budget = Selectable<TaskAgentBudgetsTable>;
export type ExecutionErrorCode = 'not_found' | 'inactive' | 'timed_out' | 'token_exhausted'
  | 'duplicate_request' | 'invalid_request' | 'prerequisites_pending' | 'canceled';

export class AgentExecutionError extends Error {
  override readonly name = 'AgentExecutionError';
  constructor(readonly code: ExecutionErrorCode) { super(`Agent execution refused (${code}).`); }
}

export interface CreateInstanceInput {
  runId: string;
  agentKey: string;
  assignmentKey: string;
  preset: AgentPreset;
  modelId: string;
  instruction?: string;
  writePaths?: string[];
}

/** C02 persistence seam. All mutations lock task -> run -> agent -> budget/call.
 * No provider or filesystem operation belongs inside these transactions.
 */
export class PgAgentLedger implements Pick<AgentService, 'recordUsage' | 'enforceDeadline'> {
  constructor(private readonly deps: { db: Db; bootId: string; now?: () => Date }) {}
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  async createInstance(input: CreateInstanceInput): Promise<Agent> {
    return this.deps.db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom('runs').selectAll().where('id', '=', input.runId).executeTakeFirst();
      if (!run) throw new AgentExecutionError('not_found');
      const task = await trx.selectFrom('tasks').selectAll().where('id', '=', run.task_id).forUpdate().executeTakeFirstOrThrow();
      const current = await trx.selectFrom('runs').selectAll().where('id', '=', run.id).forUpdate().executeTakeFirstOrThrow();
      if (task.active_run_id !== run.id || current.boot_id !== this.deps.bootId || !isActiveRunStatus(current.status)) {
        throw new AgentExecutionError('inactive');
      }
      await trx.insertInto('task_agent_budgets').values({
        workspace_id: run.workspace_id, task_id: run.task_id, agent_key: input.agentKey,
        token_budget: TASK_AGENT_TOKEN_BUDGET,
      }).onConflict((oc) => oc.columns(['task_id', 'agent_key']).doNothing()).execute();
      // Never reset a budget on conflict, including consumed and unknown usage.
      return trx.insertInto('agent_instances').values({
        workspace_id: run.workspace_id, task_id: run.task_id, run_id: run.id,
        agent_key: input.agentKey, assignment_key: input.assignmentKey, preset: input.preset,
        model_id: input.modelId, boot_id: this.deps.bootId,
        instruction: input.instruction ?? '', write_paths: input.writePaths ?? [],
      }).returningAll().executeTakeFirstOrThrow();
    });
  }

  async start(agentInstanceId: string): Promise<Agent> {
    return this.live(agentInstanceId, async (trx, agent) => {
      if (agent.started_at) return agent;
      const pending = await trx.selectFrom('agent_dependencies as d')
        .innerJoin('agent_instances as p', 'p.id', 'd.prerequisite_agent_id')
        .select('p.id').where('d.agent_id', '=', agent.id).where('p.status', '!=', 'completed').executeTakeFirst();
      if (pending) throw new AgentExecutionError('prerequisites_pending');
      const now = this.now();
      const started = await trx.updateTable('agent_instances').set({
        status: 'running', started_at: now, deadline_at: new Date(now.getTime() + AGENT_TIMEOUT_MS),
      }).where('id', '=', agent.id).returningAll().executeTakeFirstOrThrow();
      await appendEvent(trx, {
        workspaceId: agent.workspace_id, taskId: agent.task_id, runId: agent.run_id,
        eventKey: eventKeys.agentStarted(agent.id), type: 'agent.started', payload: { agentId: agent.id },
      });
      return started;
    }, true);
  }

  async assertActive(agentInstanceId: string): Promise<Agent> {
    return this.live(agentInstanceId, async (_trx, agent) => agent);
  }

  /** For short DB checkpoint/result writes. Rechecks time before commit and
   * rolls back the callback if it crossed the deadline. Git needs its own gate
   * and an assertActive check immediately before each effect (C04/D02).
   */
  async withActiveWrite<T>(agentInstanceId: string, write: (trx: Trx, agent: Agent) => Promise<T>): Promise<T> {
    try {
      return await this.live(agentInstanceId, async (trx, agent) => {
        const result = await write(trx, agent);
        if (this.expired(agent)) throw new AgentExecutionError('timed_out');
        return result;
      });
    } catch (error) {
      if (error instanceof AgentExecutionError && error.code === 'timed_out') {
        await this.enforceDeadline({ agentInstanceId });
      }
      throw error;
    }
  }

  async reserve(input: {
    agentInstanceId: string; requestKey: string; inputTokens: number;
    profile: ModelProfile; maxOutputTokens?: number;
  }): Promise<{ maxOutputTokens: number; reservedTokens: number }> {
    const { profile } = input;
    const maximum = input.maxOutputTokens ?? profile.maxOutputTokens;
    if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0 ||
        !Number.isSafeInteger(maximum) || maximum < profile.minOutputTokens || maximum > profile.maxOutputTokens ||
        !Number.isSafeInteger(profile.minOutputTokens) || profile.minOutputTokens < 1 ||
        !Number.isSafeInteger(profile.maxOutputTokens) || !input.requestKey || input.requestKey.length > 200) {
      throw new AgentExecutionError('invalid_request');
    }
    return this.live(input.agentInstanceId, async (trx, agent) => {
      if (agent.model_id !== profile.modelId) throw new AgentExecutionError('invalid_request');
      const budget = await this.lockBudget(trx, agent);
      const previous = await trx.selectFrom('model_calls').select('id')
        .where('agent_id', '=', agent.id).where('request_key', '=', input.requestKey).executeTakeFirst();
      // Replaying a reservation must never authorize a second provider call.
      if (previous) throw new AgentExecutionError('duplicate_request');
      const remaining = budget.token_budget - budget.consumed_tokens - budget.reserved_tokens - input.inputTokens;
      const maxOutputTokens = Math.min(maximum, remaining);
      if (maxOutputTokens < profile.minOutputTokens) {
        await this.stop(trx, agent, 'token_exhausted');
        return new AgentExecutionError('token_exhausted');
      }
      const reservedTokens = input.inputTokens + maxOutputTokens;
      await trx.updateTable('task_agent_budgets').set({
        reserved_tokens: budget.reserved_tokens + reservedTokens, updated_at: this.now(),
      }).where('task_id', '=', agent.task_id).where('agent_key', '=', agent.agent_key).execute();
      await trx.insertInto('model_calls').values({
        workspace_id: agent.workspace_id, task_id: agent.task_id, agent_id: agent.id,
        request_key: input.requestKey, model_id: agent.model_id, reserved_tokens: reservedTokens,
      }).execute();
      return { maxOutputTokens, reservedTokens };
    });
  }

  /** Idempotent, and deliberately allowed after timeout/cancel/restart. Missing
   * totals keep their full reservation. A later known total settles it once.
   */
  async recordUsage(input: { agentInstanceId: string; requestKey: string; usage: ModelUsage }): Promise<TaskAgentBudget> {
    const usage = modelUsageSchema.parse(input.usage);
    if (Object.values(usage).some((v) => typeof v === 'number' && !Number.isSafeInteger(v))) {
      throw new AgentExecutionError('invalid_request');
    }
    return this.deps.db.transaction().execute(async (trx) => {
      const { agent } = await this.lock(trx, input.agentInstanceId);
      const budget = await this.lockBudget(trx, agent);
      const call = await trx.selectFrom('model_calls').selectAll().where('agent_id', '=', agent.id)
        .where('request_key', '=', input.requestKey).forUpdate().executeTakeFirst();
      if (!call) throw new AgentExecutionError('not_found');
      if (call.status === 'reported') return toBudget(budget);
      const known = usage.status === 'reported' && usage.totalTokens !== undefined;
      await trx.updateTable('model_calls').set({
        status: known ? 'reported' : 'unknown', reported_usage: { ...usage, status: known ? 'reported' : 'unknown' },
        settled_at: this.now(),
      }).where('id', '=', call.id).execute();
      if (!known) return toBudget(budget);
      const consumed = budget.consumed_tokens + usage.totalTokens!;
      if (!Number.isSafeInteger(consumed)) throw new AgentExecutionError('invalid_request');
      const updated = await trx.updateTable('task_agent_budgets').set({
        consumed_tokens: consumed, reserved_tokens: budget.reserved_tokens - call.reserved_tokens,
        updated_at: this.now(),
      }).where('task_id', '=', agent.task_id).where('agent_key', '=', agent.agent_key)
        .returningAll().executeTakeFirstOrThrow();
      return toBudget(updated);
    });
  }

  /**
   * Append one step of the agent's thought process for its history.
   *
   * Like late usage, allowed after the agent is terminal: a response that
   * arrived after a deadline is still something the agent did. Append-only and
   * never read by execution, so it takes no locks and authorizes nothing.
   */
  async recordTraceStep(agentInstanceId: string, kind: 'model_turn' | 'tool_results',
    content: Record<string, unknown>): Promise<void> {
    const agent = await this.deps.db.selectFrom('agent_instances').select(['workspace_id', 'task_id', 'run_id'])
      .where('id', '=', agentInstanceId).executeTakeFirst();
    if (!agent) throw new AgentExecutionError('not_found');
    await this.deps.db.insertInto('agent_trace_steps').values({
      workspace_id: agent.workspace_id, task_id: agent.task_id, run_id: agent.run_id,
      agent_instance_id: agentInstanceId, kind, content, created_at: this.now(),
    }).execute();
  }

  async enforceDeadline(input: { agentInstanceId: string }): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      const state = await this.lock(trx, input.agentInstanceId);
      if (this.isCurrent(state) && this.isExecutable(state.agent) && this.expired(state.agent)) {
        await this.stop(trx, state.agent, 'timed_out');
      }
    });
  }

  /** Called by the coordinator's sweep, including agents waiting on a human. */
  async sweepDeadlines(): Promise<void> {
    const expired = await this.deps.db.selectFrom('agent_instances').select('id')
      .where('boot_id', '=', this.deps.bootId).where('status', 'in', ['running', 'needs_input'])
      .where('deadline_at', '<=', this.now()).execute();
    for (const agent of expired) await this.enforceDeadline({ agentInstanceId: agent.id });
  }

  private async lock(trx: Trx, id: string) {
    const ref = await trx.selectFrom('agent_instances').select(['task_id', 'run_id']).where('id', '=', id).executeTakeFirst();
    if (!ref) throw new AgentExecutionError('not_found');
    const task = await trx.selectFrom('tasks').selectAll().where('id', '=', ref.task_id).forUpdate().executeTakeFirstOrThrow();
    const run = await trx.selectFrom('runs').selectAll().where('id', '=', ref.run_id).forUpdate().executeTakeFirstOrThrow();
    const agent = await trx.selectFrom('agent_instances').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    return { task, run, agent };
  }

  private isCurrent(state: Awaited<ReturnType<PgAgentLedger['lock']>>) {
    return state.task.active_run_id === state.run.id && isActiveRunStatus(state.run.status) &&
      state.run.boot_id === this.deps.bootId && state.agent.boot_id === this.deps.bootId;
  }
  private isExecutable(agent: Agent) { return ['pending', 'running', 'needs_input'].includes(agent.status); }
  private expired(agent: Agent) { return agent.deadline_at !== null && new Date(agent.deadline_at).getTime() <= this.now().getTime(); }

  private async live<T>(id: string, work: (trx: Trx, agent: Agent) => Promise<T | AgentExecutionError>, allowPending = false): Promise<T> {
    const result = await this.deps.db.transaction().execute(async (trx) => {
      const state = await this.lock(trx, id);
      if (!this.isCurrent(state)) return new AgentExecutionError('inactive');
      const { agent } = state;
      if (agent.status === 'timed_out' || agent.status === 'token_exhausted') return new AgentExecutionError(agent.status);
      if (!this.isExecutable(agent) || (!allowPending && !agent.started_at)) return new AgentExecutionError('inactive');
      if (this.expired(agent)) {
        await this.stop(trx, agent, 'timed_out');
        return new AgentExecutionError('timed_out');
      }
      return work(trx, agent);
    });
    // Throw after commit so an expired/exhausted transition isn't rolled back.
    if (result instanceof AgentExecutionError) throw result;
    return result;
  }

  private lockBudget(trx: Trx, agent: Agent) {
    return trx.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', agent.task_id)
      .where('agent_key', '=', agent.agent_key).forUpdate().executeTakeFirstOrThrow();
  }

  private async stop(trx: Trx, agent: Agent, status: 'timed_out' | 'token_exhausted') {
    const now = this.now();
    await trx.updateTable('agent_instances').set({ status, ended_at: now }).where('id', '=', agent.id).execute();
    await trx.updateTable('agent_questions').set({ status: status === 'timed_out' ? 'expired' : 'canceled', resolved_at: now })
      .where('agent_instance_id', '=', agent.id).where('status', '=', 'open').execute();
    await trx.updateTable('tasks').set({ status: 'incomplete', updated_at: now })
      .where('id', '=', agent.task_id).where('active_run_id', '=', agent.run_id).execute();
    // The coordinator settles the run once other parallel agents finish. Their
    // accepted work and independent budgets remain usable in the meantime.
    await appendEvent(trx, {
      workspaceId: agent.workspace_id, taskId: agent.task_id, runId: agent.run_id,
      eventKey: eventKeys.agentSettled(agent.id, status), type: status === 'timed_out' ? 'agent.timed_out' : 'agent.token_exhausted',
      payload: { agentId: agent.id },
    });
    // Requests that may have reached the provider retain their reservation.
    await trx.updateTable('model_calls').set({ status: 'unknown', reported_usage: { status: 'unknown' }, settled_at: now })
      .where('agent_id', '=', agent.id).where('status', '=', 'reserved').execute();
  }
}

function toBudget(row: Budget): TaskAgentBudget {
  return { taskId: row.task_id, agentKey: row.agent_key, tokenBudget: row.token_budget,
    consumedTokens: row.consumed_tokens, reservedTokens: row.reserved_tokens };
}
