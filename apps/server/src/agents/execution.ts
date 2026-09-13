import { ModelAdapterError, type AgentRequest, type AgentResponse, type ModelAdapter, type ToolResult } from '../models/types.js';
import { AgentExecutionError, PgAgentLedger } from './ledger.js';
import { modelTurnContent, toolResultsContent } from './trace.js';

/**
 * Output ceiling a caller gets when it does not ask for one.
 *
 * `reserve` holds `inputTokens + maxOutputTokens`, and with no ceiling that is
 * the model's own maximum. Before the task budget was expanded, a 65536-token
 * model allowance could reserve an agent's entire 64000-token budget on its
 * first call. Measured against a live run, the calls that produced a working
 * plan and a written file counted 521–1472 input tokens and billed 1311–2306
 * total, making that reservation disproportionately large.
 *
 * It cost a run whenever a call failed in a way that could have been billed:
 * the hold is kept, the agent's remaining budget is zero, and every later
 * attempt dies as `token_exhausted` without reaching the provider at all —
 * which is exactly the three-attempt failure this was found from.
 *
 * 32768 leaves substantial room for long worker outputs while the 256000-token
 * task-agent budget still keeps multiple calls and a stranded reservation
 * survivable. A caller that genuinely needs more still passes
 * `maxOutputTokens` explicitly.
 */
export const DEFAULT_OUTPUT_ALLOWANCE = 32_768;

/**
 * How long to wait before retrying a refused request.
 *
 * The caller's exponential ladder is a floor, not the answer. A quota response
 * states when a slot actually frees; retrying earlier is a refusal the provider
 * already predicted, and against a per-day quota it also spends a request from
 * the allowance being waited on. Taking the larger of the two keeps the ladder's
 * behaviour for errors that say nothing, and obeys the provider when it does.
 */
export function providerBackoffMs(error: ModelAdapterError, ladderMs: number): number {
  return Math.max(ladderMs, error.retryDelayMs ?? 0);
}

export interface ExecutionDeps {
  ledger: PgAgentLedger;
  adapter: ModelAdapter;
  agentInstanceId: string;
  /** Report persistence failures from timers or usage arriving after cancellation. */
  onBackgroundError: (error: unknown) => void;
  /**
   * Per-call token accounting, for the process log.
   *
   * A `token_exhausted` agent says nothing about which of the three numbers
   * went wrong: what the prompt counted, what the budget granted, or what the
   * provider actually billed. Without them the same symptom covers an oversized
   * context, a stranded reservation and a genuine limit.
   */
  onAccounting?: (info: {
    agentInstanceId: string; preset: string;
    inputTokens: number; requested: number | undefined;
    granted: number; reserved: number;
    outcome: 'ok' | 'failed'; usage?: string;
  }) => void;
  now?: () => number;
}

/** One execution scope for model calls, tool work, backoff and human waits.
 * Reopening the same instance reads the persisted deadline; it never resets it.
 * The coordinator closes this scope on completion, cancel, or shutdown.
 */
export class AgentExecution {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly pending = new Set<Promise<unknown>>();
  readonly signal: AbortSignal = this.controller.signal;

  private constructor(private readonly deps: ExecutionDeps, readonly deadlineAt: number) {
    this.timer = setTimeout(() => {
      this.controller.abort(new AgentExecutionError('timed_out'));
      void deps.ledger.enforceDeadline({ agentInstanceId: deps.agentInstanceId })
        .catch(deps.onBackgroundError);
    }, Math.max(0, deadlineAt - this.now()));
    this.timer.unref?.();
  }

  static async open(deps: ExecutionDeps): Promise<AgentExecution> {
    const agent = await deps.ledger.start(deps.agentInstanceId);
    return new AgentExecution(deps, new Date(agent.deadline_at!).getTime());
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  /**
   * Whether a wait of this length still leaves the fixed deadline room to act.
   *
   * This is not a retry quota (section 9.4 forbids one): it counts time, not
   * attempts. A wait that outlasts the deadline cannot be followed by a model
   * call, so the agent has already failed — it just has not said so yet. Idling
   * to the ten-minute mark and reporting `timed_out` instead names the clock as
   * the cause when the real one was the provider, which is exactly what made a
   * rate-limited run read as an unexplained hang.
   */
  canWait(ms: number): boolean { return this.now() + ms < this.deadlineAt; }

  /** Wrap tool/backoff/question waits too. A tool must separately guard every
   * write using ledger.withActiveWrite (DB) or its Git/document mutation gate.
   * Racing a promise cannot revoke arbitrary side effects within that promise.
   */
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = (async () => {
      await this.deps.ledger.assertActive(this.deps.agentInstanceId);
      this.checkSignal();
      const result = await work(this.signal);
      await this.deps.ledger.assertActive(this.deps.agentInstanceId);
      this.checkSignal();
      return result;
    })();
    // Attach both handlers immediately: providers can settle after the race.
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), (error: unknown) => {
      this.pending.delete(operation);
      if (this.signal.aborted && !(error instanceof AgentExecutionError) && !(error instanceof ModelAdapterError)) {
        this.deps.onBackgroundError(error);
      }
    });
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([operation, aborted]);
    } catch (error) {
      if (this.now() >= this.deadlineAt) {
        await this.deps.ledger.enforceDeadline({ agentInstanceId: this.deps.agentInstanceId });
        throw new AgentExecutionError('timed_out');
      }
      throw error;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Each provider retry is another invocation with a fresh request key.
   * Duplicate keys are refused, never replayed as a second generation.
   */
  generate(requestKey: string, request: AgentRequest, options: { maxOutputTokens?: number } = {}): Promise<AgentResponse> {
    // Snapshot synchronously, before the caller can mutate its original object.
    const snapshot = structuredClone(request);
    // Never let an unspecified ceiling mean "the whole budget".
    const desiredMaximum = options.maxOutputTokens ?? DEFAULT_OUTPUT_ALLOWANCE;
    return this.run(async (signal) => {
      const { ledger, adapter, agentInstanceId } = this.deps;
      const agent = await ledger.assertActive(agentInstanceId);
      const profile = adapter.getModel(snapshot.preset);
      if (agent.preset !== snapshot.preset || agent.model_id !== profile.modelId) {
        throw new AgentExecutionError('invalid_request');
      }
      // Both calls receive identical deep snapshots, including tools, system
      // instruction, schema, repeated context and opaque provider state.
      const inputTokens = await adapter.countInput(structuredClone(snapshot), signal);
      this.checkSignal();
      const allowance = await ledger.reserve({ agentInstanceId, requestKey, inputTokens, profile,
        maxOutputTokens: desiredMaximum });
      const account = (outcome: 'ok' | 'failed', usage?: string) =>
        this.deps.onAccounting?.({
          agentInstanceId, preset: snapshot.preset, inputTokens,
          requested: desiredMaximum, granted: allowance.maxOutputTokens,
          reserved: allowance.reservedTokens, outcome, ...(usage ? { usage } : {}),
        });
      let sent = false;
      let response: AgentResponse;
      try {
        await ledger.assertActive(agentInstanceId);
        this.checkSignal();
        // From this point an error can mean the provider accepted the request.
        sent = true;
        response = await adapter.generate(structuredClone(snapshot), { maxOutputTokens: allowance.maxOutputTokens }, signal);
      } catch (error) {
        /*
         * A refused request was never billed, so its reservation must not be
         * held (section 9.3).
         *
         * `sent` is set before the call on purpose: once the request leaves,
         * an error can still mean the provider generated something, and
         * charging nothing would understate the budget. But a request the
         * provider *refused* — a transport failure, 408, 429, or a 5xx — did no
         * work and reported no counters, and the adapter already distinguishes
         * exactly that case as `retryable`.
         *
         * Holding those reservations is what turned one transient 503 into a
         * dead run: `reserve` takes input + the whole remaining allowance, so a
         * single unsettled call leaves nothing for the retry the README says
         * belongs to application code, and the run dies as `token_exhausted`
         * several layers from the cause.
         *
         * Deliberately narrow. A permanent 4xx keeps the old behaviour: the
         * agent is failing anyway, and the reservation cannot matter. Only a
         * refusal that carries no counters at all releases.
         */
        const refused = error instanceof ModelAdapterError && error.retryable &&
          error.usage.status !== 'reported' && error.usage.totalTokens === undefined;
        account('failed', error instanceof ModelAdapterError
          ? `${error.code} refused=${refused} usage=${error.usage.status}` : 'non-adapter error');
        await ledger.recordUsage({ agentInstanceId, requestKey, usage: !sent || refused
          ? { status: 'reported', totalTokens: 0 }
          : error instanceof ModelAdapterError ? error.usage : { status: 'unknown' } });
        throw error;
      }
      // Always settle before the live guard, even for an aborted late response.
      await ledger.recordUsage({ agentInstanceId, requestKey, usage: response.usage });
      account('ok', `${response.usage.status} total=${response.usage.totalTokens ?? '?'} ` +
        `thinking=${response.usage.thinkingTokens ?? '?'} finish=${response.finishReason ?? 'none'}`);
      await this.trace('model_turn', modelTurnContent(response));
      return response;
    });
  }

  /** Record the tool outcomes the model is about to see, for agent history. */
  recordToolResults(results: ToolResult[]): Promise<void> {
    return results.length ? this.trace('tool_results', toolResultsContent(results)) : Promise.resolve();
  }

  /**
   * History is evidence, not execution state: a failed write is reported and
   * never fails the agent, and nothing reads a trace back to decide anything.
   */
  private async trace(kind: 'model_turn' | 'tool_results', content: Record<string, unknown>): Promise<void> {
    try { await this.deps.ledger.recordTraceStep(this.deps.agentInstanceId, kind, content); }
    catch (error) { this.deps.onBackgroundError(error); }
  }

  close(): void {
    clearTimeout(this.timer);
    this.controller.abort(new AgentExecutionError('canceled'));
  }

  /** Optional orderly drain. Providers that ignore abort may never settle, so
   * shutdown must not wait indefinitely on this method.
   */
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }

  private checkSignal(): void {
    if (this.now() >= this.deadlineAt) {
      this.controller.abort(new AgentExecutionError('timed_out'));
    }
    if (this.signal.aborted) throw this.signal.reason;
  }
}
