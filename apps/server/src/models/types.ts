import type { AgentPreset, ModelUsage } from '@app/contracts';

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  name: string;
  result: Record<string, unknown>;
}

export interface AgentResponse {
  text?: string;
  toolCalls: ToolCall[];
  usage: ModelUsage;
  /** Opaque, server-only protocol state. Store and replay without editing. */
  providerState?: unknown;
  /** A truncated or blocked response must not be mistaken for completion. */
  finishReason?: string;
  blockReason?: string;
}

export type AgentMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; response: AgentResponse }
  | { role: 'tool'; results: ToolResult[] };

/** Internal input only: model IDs and arbitrary SDK settings are not accepted. */
export interface AgentRequest {
  preset: AgentPreset;
  messages: AgentMessage[];
  systemInstruction?: string;
  tools?: ToolDefinition[];
  responseJsonSchema?: Record<string, unknown>;
}

export interface RequestAllowance {
  /** Combined generated-token ceiling, INCLUDING thinking, not just text. */
  maxOutputTokens: number;
  /** Optional explicit thinking allocation within that ceiling. */
  thinkingBudget?: number;
}

export interface ModelAdapter {
  /** Verified provider bounds; minimum includes any mandatory thinking. */
  getModel(preset: AgentRequest['preset']): ModelProfile;
  countInput(request: AgentRequest, signal?: AbortSignal): Promise<number>;
  generate(
    request: AgentRequest,
    limits: RequestAllowance,
    signal: AbortSignal,
  ): Promise<AgentResponse>;
}

export interface ModelProfile {
  modelId: string;
  minOutputTokens: number;
  maxOutputTokens: number;
}

export type ModelErrorCode =
  | 'configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'rate_limited'
  | 'provider_error'
  | 'aborted';

/** Safe to report: never retains raw provider errors, prompts, or credentials. */
export class ModelAdapterError extends Error {
  override readonly name = 'ModelAdapterError';

  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
    readonly usage: ModelUsage = { status: 'unknown' },
  ) {
    super(message);
  }
}

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ModelAdapterError('aborted', 'Model operation was canceled.');
  }
}
