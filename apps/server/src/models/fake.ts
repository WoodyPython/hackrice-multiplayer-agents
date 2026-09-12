import {
  checkAborted,
  ModelAdapterError,
  type AgentRequest,
  type AgentResponse,
  type ModelAdapter,
  type RequestAllowance,
} from './types.js';

export interface FakeModelStep {
  inputTokens: number;
  result: AgentResponse | Error | ((signal: AbortSignal) => Promise<AgentResponse>);
}

/** Explicit fixtures, never a text-length token estimate or production fallback. */
export class FakeModelAdapter implements ModelAdapter {
  readonly counts: AgentRequest[] = [];
  readonly calls: Array<{ request: AgentRequest; limits: RequestAllowance }> = [];
  private cursor = 0;

  constructor(private readonly steps: readonly FakeModelStep[]) {}

  getModel(_preset: AgentRequest['preset']) {
    return { modelId: 'fake', minOutputTokens: 1, maxOutputTokens: 65536 };
  }

  private next(): FakeModelStep {
    const step = this.steps[this.cursor];
    if (!step) throw new ModelAdapterError('invalid_request', 'Fake model script is exhausted.');
    return step;
  }

  async countInput(request: AgentRequest, signal?: AbortSignal): Promise<number> {
    checkAborted(signal);
    this.counts.push(structuredClone(request));
    return this.next().inputTokens;
  }

  async generate(request: AgentRequest, limits: RequestAllowance, signal: AbortSignal): Promise<AgentResponse> {
    checkAborted(signal);
    const step = this.next();
    this.cursor += 1;
    this.calls.push({ request: structuredClone(request), limits: structuredClone(limits) });
    if (step.result instanceof Error) throw step.result;
    // Callbacks can emulate delayed success, abort, or late billed responses.
    return structuredClone(typeof step.result === 'function' ? await step.result(signal) : step.result);
  }
}
