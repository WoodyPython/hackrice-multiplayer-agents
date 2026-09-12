import { sql } from 'kysely';
import {
  ApiError,
  TASK_AGENT_TOKEN_BUDGET,
  type ModelUsage,
  type TaskAgentBudget,
} from '@app/contracts';
import type { Transaction } from 'kysely';
import { isUniqueViolation, type Db } from '../db/client.js';
import type { Database } from '../db/types.js';

type Trx = Transaction<Database>;

/**
 * B07: per-task, per-agent token accounting (design section 9.3).
 *
 * "Each task-and-agent pair has its own cumulative budget... Key the budget by
 * task_id and a stable agent_key. Reuse that key for the same logical agent
 * across execution attempts, retries, and model changes."
 *
 * The ledger has three states per model call and they are not interchangeable:
 *
 *   reserved  the call is about to happen; the tokens are spoken for
 *   reported  the provider told us what it actually cost
 *   unknown   the call failed without usable usage, and section 9.3 is explicit
 *             that the reservation is NOT returned
 *
 * That last one is the whole reason this is a ledger rather than a counter.
 * Giving budget back on a failed call would let a agent that keeps failing
 * consume unbounded provider capacity while its recorded usage stays at zero.
 */

export interface BudgetLedgerDeps {
  db: Db;
}

export interface ReserveResult {
  /** Idempotent: false when this request key had already reserved. */
  reserved: boolean;
  budget: TaskAgentBudget;
  /** What remains after this reservation. Derive the output allowance from it. */
  remainingTokens: number;
}

export class PgBudgetLedger {
  constructor(private readonly deps: BudgetLedgerDeps) {}

  /**
   * Creates the budget row for a logical agent, or returns the existing one.
   *
   * Section 14.3: a retry "reuses the same task-and-agent budget rows and
   * accumulated usage. An exhausted budget remains exhausted on retry." So this
   * is create-if-absent and never reset, which is why it is separate from
   * creating an agent instance: instances are per-attempt, budgets are not.
   */
  async ensure(
    workspaceId: string,
    taskId: string,
    agentKey: string,
    tokenBudget: number = TASK_AGENT_TOKEN_BUDGET,
  ): Promise<TaskAgentBudget> {
    const existing = await this.read(taskId, agentKey);
    if (existing) return existing;

    try {
      const row = await this.deps.db
        .insertInto('task_agent_budgets')
        .values({
          workspace_id: workspaceId,
          task_id: taskId,
          agent_key: agentKey,
          token_budget: tokenBudget,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toBudget(row);
    } catch (error) {
      // Any unique violation means a concurrent caller created it first.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.read(taskId, agentKey);
      if (!winner) throw error;
      return winner;
    }
  }

  /**
   * Reserves tokens for one model call, or refuses.
   *
   * Section 9.3 steps 2 to 4: subtract consumed and reserved from the budget,
   * and stop before the call if insufficient allowance remains.
   *
   * The check and the reservation are one statement. They cannot be split:
   * several of an agent's calls can be prepared concurrently, and a read
   * followed by a write would let two of them both see enough headroom and both
   * take it. The WHERE clause is the check.
   */
  async reserve(input: {
    agentInstanceId: string;
    requestKey: string;
    tokens: number;
    modelId: string;
  }): Promise<ReserveResult> {
    if (input.tokens < 0) {
      throw new ApiError('VALIDATION_FAILED', 'Reservation cannot be negative.');
    }

    return this.deps.db.transaction().execute(async (trx) => {
      const agent = await trx
        .selectFrom('agent_instances')
        .select(['id', 'workspace_id', 'task_id', 'agent_key', 'status'])
        .where('id', '=', input.agentInstanceId)
        .executeTakeFirst();
      if (!agent) throw new ApiError('RUN_NOT_FOUND', 'No such agent instance.');

      const existing = await trx
        .selectFrom('model_calls')
        .selectAll()
        .where('agent_id', '=', input.agentInstanceId)
        .where('request_key', '=', input.requestKey)
        .executeTakeFirst();
      if (existing) {
        const budget = await this.readIn(trx, agent.task_id, agent.agent_key);
        return { reserved: false, budget, remainingTokens: remaining(budget) };
      }

      const updated = await trx
        .updateTable('task_agent_budgets')
        .set((eb) => ({
          reserved_tokens: eb('reserved_tokens', '+', input.tokens),
          updated_at: new Date(),
        }))
        .where('task_id', '=', agent.task_id)
        .where('agent_key', '=', agent.agent_key)
        .where(
          sql<boolean>`token_budget - consumed_tokens - reserved_tokens >= ${input.tokens}`,
        )
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        const current = await this.readIn(trx, agent.task_id, agent.agent_key);
        throw new ApiError(
          'AGENT_TOKEN_EXHAUSTED',
          'This agent has no token budget left for this task.',
          {
            agentKey: agent.agent_key,
            tokenBudget: current.tokenBudget,
            consumedTokens: current.consumedTokens,
            reservedTokens: current.reservedTokens,
            requestedTokens: input.tokens,
          },
        );
      }

      await trx
        .insertInto('model_calls')
        .values({
          workspace_id: agent.workspace_id,
          task_id: agent.task_id,
          agent_id: agent.id,
          request_key: input.requestKey,
          model_id: input.modelId,
          reserved_tokens: input.tokens,
          status: 'reserved',
        })
        .execute();

      const budget = toBudget(updated);
      return { reserved: true, budget, remainingTokens: remaining(budget) };
    });
  }

  /**
   * Settles a reservation against what the provider actually reported.
   *
   * Section 9.3: "Use reported total usage when it covers the required
   * categories; do not sum total plus its components." So a reported
   * totalTokens wins outright, and the components are only summed when no total
   * came back.
   *
   * Idempotent through the model_calls status guard: settling twice would
   * double-charge, and a retried settle after a lost response is a normal thing
   * for a caller to do.
   */
  async reconcile(input: {
    agentInstanceId: string;
    requestKey: string;
    usage: ModelUsage;
    providerRequestId?: string | null;
  }): Promise<TaskAgentBudget> {
    return this.deps.db.transaction().execute(async (trx) => {
      const call = await trx
        .updateTable('model_calls')
        .set({
          status: input.usage.status === 'reported' ? 'reported' : 'unknown',
          reported_usage: input.usage as unknown as Record<string, unknown>,
          provider_request_id: input.providerRequestId ?? null,
          settled_at: new Date(),
        })
        .where('agent_id', '=', input.agentInstanceId)
        .where('request_key', '=', input.requestKey)
        .where('status', '=', 'reserved')
        .returningAll()
        .executeTakeFirst();

      const agent = await trx
        .selectFrom('agent_instances')
        .select(['task_id', 'agent_key'])
        .where('id', '=', input.agentInstanceId)
        .executeTakeFirst();
      if (!agent) throw new ApiError('RUN_NOT_FOUND', 'No such agent instance.');

      // Already settled. Return the ledger unchanged rather than charging again.
      if (!call) return this.readIn(trx, agent.task_id, agent.agent_key);

      const actual = billableTokens(input.usage, call.reserved_tokens);

      const updated = await trx
        .updateTable('task_agent_budgets')
        .set((eb) => ({
          // greatest() is belt and braces: the status guard above already makes
          // double-settling impossible, and a negative reservation would be a
          // silent accounting corruption rather than a loud failure.
          reserved_tokens: sql<number>`greatest(0, reserved_tokens - ${call.reserved_tokens})`,
          consumed_tokens: eb('consumed_tokens', '+', actual),
          updated_at: new Date(),
        }))
        .where('task_id', '=', agent.task_id)
        .where('agent_key', '=', agent.agent_key)
        .returningAll()
        .executeTakeFirstOrThrow();

      return toBudget(updated);
    });
  }

  /**
   * Settles a call whose usage never arrived.
   *
   * Section 9.3: "For missing usage after a failed request, retain its
   * reservation as unknown rather than giving the agent that budget back."
   *
   * Implemented by moving the reservation into consumed rather than leaving it
   * in reserved. The charge is retained either way, but leaving it reserved
   * would accumulate phantom holds that never clear, and the remaining-budget
   * arithmetic could not tell a live in-flight call from a dead one.
   */
  async abandon(input: {
    agentInstanceId: string;
    requestKey: string;
  }): Promise<TaskAgentBudget> {
    return this.reconcile({
      agentInstanceId: input.agentInstanceId,
      requestKey: input.requestKey,
      usage: { status: 'unknown' },
    });
  }

  async read(taskId: string, agentKey: string): Promise<TaskAgentBudget | undefined> {
    const row = await this.deps.db
      .selectFrom('task_agent_budgets')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('agent_key', '=', agentKey)
      .executeTakeFirst();
    return row ? toBudget(row) : undefined;
  }

  async listForTask(taskId: string): Promise<TaskAgentBudget[]> {
    const rows = await this.deps.db
      .selectFrom('task_agent_budgets')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('agent_key')
      .execute();
    return rows.map(toBudget);
  }

  private async readIn(
    trx: Trx,
    taskId: string,
    agentKey: string,
  ): Promise<TaskAgentBudget> {
    const row = await trx
      .selectFrom('task_agent_budgets')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('agent_key', '=', agentKey)
      .executeTakeFirst();
    if (!row) throw new ApiError('RUN_NOT_FOUND', 'No budget for this task and agent.');
    return toBudget(row);
  }
}

// ---------------------------------------------------------------------------

/**
 * What a call actually cost.
 *
 * Section 9.3: "Use reported total usage when it covers the required
 * categories; do not sum total plus its components." Summing both is the
 * obvious mistake and roughly doubles every charge.
 *
 * "Cached input remains part of logical token usage; do not add it twice if
 * already included in prompt/total counts" — so cached input is never added on
 * its own here; a provider that reports it separately from the total is
 * reporting a subset of what the total already covers.
 *
 * With nothing reported, the reservation stands as the charge.
 */
export function billableTokens(usage: ModelUsage, reserved: number): number {
  if (usage.status !== 'reported') return reserved;
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;

  const parts = [usage.inputTokens, usage.outputTokens, usage.thinkingTokens].filter(
    (n): n is number => typeof n === 'number',
  );
  if (parts.length === 0) return reserved;
  return parts.reduce((a, b) => a + b, 0);
}

function remaining(budget: TaskAgentBudget): number {
  return Math.max(0, budget.tokenBudget - budget.consumedTokens - budget.reservedTokens);
}

function toBudget(row: {
  task_id: string;
  agent_key: string;
  token_budget: number;
  consumed_tokens: number;
  reserved_tokens: number;
}): TaskAgentBudget {
  return {
    taskId: row.task_id,
    agentKey: row.agent_key,
    tokenBudget: Number(row.token_budget),
    consumedTokens: Number(row.consumed_tokens),
    reservedTokens: Number(row.reserved_tokens),
  };
}
