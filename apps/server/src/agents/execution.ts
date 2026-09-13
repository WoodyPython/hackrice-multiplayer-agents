import { ModelAdapterError, type AgentRequest, type AgentResponse, type ModelAdapter } from '../models/types.js';
import { AgentExecutionError, PgAgentLedger } from './ledger.js';

interface ExecutionDeps {
  ledger: PgAgentLedger;
  adapter: ModelAdapter;
  agentInstanceId: string;
  /** Report persistence failures from timers or usage arriving after cancellation. */
  onBackgroundError: (error: unknown) => void;
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
    const desiredMaximum = options.maxOutputTokens;
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
        await ledger.recordUsage({ agentInstanceId, requestKey, usage: !sent || refused
          ? { status: 'reported', totalTokens: 0 }
          : error instanceof ModelAdapterError ? error.usage : { status: 'unknown' } });
        throw error;
      }
      // Always settle before the live guard, even for an aborted late response.
      await ledger.recordUsage({ agentInstanceId, requestKey, usage: response.usage });
      return response;
    });
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
