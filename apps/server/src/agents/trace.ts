import { AGENT_TRACE_TEXT_MAX, clipTraceValue } from '@app/contracts';
import type { AgentResponse, ToolResult } from '../models/types.js';

/**
 * What an agent history records for each step (see migration 0013).
 *
 * Built only from normalized response fields, never from `providerState`: the
 * opaque protocol state carries signatures and must stay server-internal.
 * Strings are clipped so a trace never becomes a second copy of the files the
 * agent read or wrote — the diff already holds its real output.
 */
export function modelTurnContent(response: AgentResponse): Record<string, unknown> {
  const clip = (value: string | undefined) => value ? clipTraceValue(value, AGENT_TRACE_TEXT_MAX) as string : null;
  return {
    thoughts: clip(response.thoughts),
    text: clip(response.text),
    toolCalls: response.toolCalls.map((call) => ({
      name: call.name,
      arguments: clipTraceValue(call.arguments),
    })),
    finishReason: response.finishReason ?? null,
  };
}

/**
 * Tool outcomes as the model saw them. Only `repairableToolError` shapes count
 * as errors here; they already carry codes and no raw exception text.
 */
export function toolResultsContent(results: ToolResult[]): Record<string, unknown> {
  return {
    results: results.map(({ name, result }) => {
      const error = result.error;
      const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : null;
      return { name, outcome: errorCode ? 'error' : 'ok', errorCode, detail: clipTraceValue(result) };
    }),
  };
}
