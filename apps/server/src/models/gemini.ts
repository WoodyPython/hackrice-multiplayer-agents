import {
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type Models,
  type Tool,
} from '@google/genai';
import { agentPresetSchema, modelUsageSchema } from '@app/contracts';
import type { AppConfig } from '../config.js';
import {
  checkAborted,
  ModelAdapterError,
  type AgentRequest,
  type AgentResponse,
  type ModelAdapter,
  type RequestAllowance,
  type ToolCall,
} from './types.js';

type ModelConfig = Pick<AppConfig, 'GEMINI_API_KEY' | 'ORCHESTRATOR_MODEL' | 'WORKER_MODEL'>;
/** Injectable SDK boundary for tests; production always uses createGeminiAdapter. */
export type GeminiClient = { models: Pick<Models, 'countTokens' | 'generateContent'> };

interface GeminiState {
  provider: 'gemini';
  model: string;
  content: Content;
}

// Add a model only after verifying its counting and thinking/output semantics.
// For these models maxOutputTokens covers thinking AND visible output.
const MODEL_PROFILES: Record<string, { minThinking: number; maxThinking: number; maxOutput: number }> = {
  // `maxOutput` is each model's reported outputTokenLimit, read from
  // models.list() rather than assumed; `npm run gemini:smoke` prints them.
  'gemini-3.1-pro-preview': { minThinking: 128, maxThinking: 32768, maxOutput: 65536 },
  'gemini-3.8-flash': { minThinking: 0, maxThinking: 24576, maxOutput: 65536 },
  'gemini-3.6-flash': { minThinking: 0, maxThinking: 24576, maxOutput: 65536 },

  // Retired 2026-09: reachable in models.list() but countTokens answers 404,
  // "no longer available to new users". Kept so an old .env fails in the
  // adapter with a message naming the model, rather than as a bare provider
  // 404 from the first agent that runs.
  'gemini-2.5-pro': { minThinking: 128, maxThinking: 32768, maxOutput: 65536 },
  'gemini-2.5-flash': { minThinking: 0, maxThinking: 24576, maxOutput: 65536 },
};

/**
 * What the provider actually said, for the server log only.
 *
 * `ModelAdapterError` is documented as safe to report anywhere, so it keeps no
 * provider text — which left a failed Start with nothing but `provider_error`
 * and no way to tell a rejected key from an unavailable model from a malformed
 * request. Section 13.3 forbids provider text reaching the *browser*; it does
 * not ask us to destroy it. This reports it to the process log instead, with
 * anything key-shaped removed.
 */
export type ProviderDiagnostic = (info: {
  model: string;
  status: number | undefined;
  detail: string;
}) => void;

let reportProviderError: ProviderDiagnostic | undefined;

/** Set once at runtime assembly. Absent in tests, which assert on codes. */
export function setProviderDiagnostic(sink: ProviderDiagnostic | undefined): void {
  reportProviderError = sink;
}

export function createGeminiAdapter(config: ModelConfig): ModelAdapter {
  if (!config.GEMINI_API_KEY?.trim()) {
    throw new ModelAdapterError('configuration', 'GEMINI_API_KEY is required for agent execution.');
  }
  return new GeminiAdapter(config, new GoogleGenAI({
    apiKey: config.GEMINI_API_KEY,
    vertexai: false,
    httpOptions: { retryOptions: { attempts: 1 } },
  }));
}

export class GeminiAdapter implements ModelAdapter {
  private readonly routing: { orchestrator: string; worker: string };

  constructor(config: ModelConfig, private readonly client: GeminiClient) {
    this.routing = {
      orchestrator: config.ORCHESTRATOR_MODEL.replace(/^models\//, ''),
      worker: config.WORKER_MODEL.replace(/^models\//, ''),
    };
    for (const model of Object.values(this.routing)) {
      if (!Object.hasOwn(MODEL_PROFILES, model)) {
        // Naming the model matters: Google retires model IDs, and the old
        // message sent someone hunting through config for a value that was
        // already correct. The missing thing is the profile, not the name.
        throw new ModelAdapterError('configuration',
          `Model "${model}" has no verified token/thinking profile. Run ` +
          '`npm run gemini:smoke --workspace @app/server` to see which models this ' +
          'key can reach and their limits, then add an entry to MODEL_PROFILES.');
      }
    }
  }

  getModel(preset: AgentRequest['preset']) {
    agentPresetSchema.parse(preset);
    const modelId = preset === 'orchestrator' ? this.routing.orchestrator : this.routing.worker;
    const profile = MODEL_PROFILES[modelId]!;
    return { modelId, minOutputTokens: profile.minThinking + 1, maxOutputTokens: profile.maxOutput };
  }

  private prepare(request: AgentRequest) {
    if (!agentPresetSchema.safeParse(request.preset).success || request.messages.length === 0) {
      throw new ModelAdapterError('invalid_request', 'A valid preset and conversation are required.');
    }
    const model = request.preset === 'orchestrator' ? this.routing.orchestrator : this.routing.worker;
    const contents: Content[] = request.messages.map((message) => {
      switch (message.role) {
        case 'user':
          return { role: 'user', parts: [{ text: message.text }] };
        case 'assistant': {
          const state = message.response.providerState as GeminiState | undefined;
          if (state?.provider !== 'gemini' || state.model !== model ||
              state.content?.role !== 'model' || !Array.isArray(state.content.parts)) {
            throw new ModelAdapterError('invalid_request', 'Assistant history requires original state from the same Gemini model.');
          }
          // Never reconstruct from text/toolCalls: signatures can occur on ANY part.
          return structuredClone(state.content);
        }
        case 'tool':
          if (message.results.length === 0) {
            throw new ModelAdapterError('invalid_request', 'A tool turn requires at least one result.');
          }
          return {
            role: 'user',
            parts: message.results.map((result) => ({
              functionResponse: {
                ...(result.id ? { id: result.id } : {}),
                name: result.name,
                response: structuredClone(result.result),
              },
            })),
          };
      }
    });
    const tools: Tool[] | undefined = request.tools?.length ? [{
      functionDeclarations: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: structuredClone(tool.parameters),
      })),
    }] : undefined;
    const systemInstruction: Content | undefined = request.systemInstruction !== undefined
      ? { parts: [{ text: request.systemInstruction }] }
      : undefined;
    const outputFormat = request.responseJsonSchema === undefined ? {} : {
      responseMimeType: 'application/json',
      responseJsonSchema: structuredClone(request.responseJsonSchema),
    };
    return { model, contents, tools, systemInstruction, outputFormat };
  }

  async countInput(request: AgentRequest, signal?: AbortSignal): Promise<number> {
    checkAborted(signal);
    const prepared = this.prepare(request);
    try {
      // The SDK's Developer API countTokens converter rejects systemInstruction
      // and tools. Its documented extraBody escape hatch carries the REST API's
      // full generateContentRequest instead. Null clears the contents shorthand.
      const response = await this.client.models.countTokens({
        model: prepared.model,
        contents: prepared.contents,
        config: {
          abortSignal: signal,
          httpOptions: {
            retryOptions: { attempts: 1 },
            extraBody: {
              contents: null,
              generateContentRequest: {
                model: `models/${prepared.model}`,
                contents: prepared.contents,
                systemInstruction: prepared.systemInstruction,
                tools: prepared.tools,
                generationConfig: prepared.outputFormat,
              },
            },
          },
        },
      });
      checkAborted(signal);
      if (!isTokenCount(response.totalTokens)) {
        throw new ModelAdapterError('invalid_response', 'Gemini did not return a valid input token count.');
      }
      return response.totalTokens;
    } catch (error) {
      throw safeError(error, signal, this.routing[request.preset === 'orchestrator' ? 'orchestrator' : 'worker']);
    }
  }

  async generate(request: AgentRequest, limits: RequestAllowance, signal: AbortSignal): Promise<AgentResponse> {
    checkAborted(signal);
    const prepared = this.prepare(request);
    const profile = MODEL_PROFILES[prepared.model]!;
    if (!isTokenCount(limits.maxOutputTokens) || limits.maxOutputTokens <= profile.minThinking ||
        limits.maxOutputTokens > profile.maxOutput) {
      throw new ModelAdapterError('invalid_request', 'Output allowance is outside the configured model bounds.');
    }
    const thinkingBudget = limits.thinkingBudget ?? Math.min(
      profile.maxThinking,
      Math.max(profile.minThinking, Math.floor(limits.maxOutputTokens / 4)),
    );
    if (!isTokenCount(thinkingBudget) || thinkingBudget < profile.minThinking ||
        thinkingBudget > profile.maxThinking || thinkingBudget >= limits.maxOutputTokens) {
      throw new ModelAdapterError('invalid_request', 'Thinking allowance must fit the model bounds and combined output allowance.');
    }
    const config: GenerateContentConfig = {
      systemInstruction: prepared.systemInstruction,
      tools: prepared.tools,
      ...prepared.outputFormat,
      candidateCount: 1,
      maxOutputTokens: limits.maxOutputTokens,
      // Thought summaries feed agent history. They arrive as separate `thought`
      // parts, so they never mix into the answer text below.
      thinkingConfig: { thinkingBudget, includeThoughts: true },
      automaticFunctionCalling: { disable: true },
      httpOptions: { retryOptions: { attempts: 1 } },
      abortSignal: signal,
    };
    try {
      const response = await this.client.models.generateContent({
        model: prepared.model, contents: prepared.contents, config,
      });
      // Return late usage for ledger reconciliation. C02 must reject late writes
      // using the live deadline/status; an abort does not erase provider usage.
      return normalizeResponse(response, prepared.model);
    } catch (error) {
      throw safeError(error, signal, prepared.model);
    }
  }
}

/**
 * The provider's own message, with anything that looks like a credential gone.
 *
 * Google echoes the request in some errors, so this strips `key=` query values
 * and any long opaque token before the text reaches the log.
 */
function redactProviderDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message
    : typeof error === 'string' ? error
      : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  return raw
    .replace(/key=[^&\s"']+/gi, 'key=[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]')
    .slice(0, 600);
}

/**
 * When the provider says a slot will be free again, in milliseconds.
 *
 * A 429 carries `google.rpc.RetryInfo` and repeats the same figure in its
 * message. Discarding it and retrying on a local ladder produces a refusal the
 * provider already told us was too early — and on a per-day quota each of those
 * still spends a request from the allowance being waited on. Measured against a
 * rate-limited writer, thirteen of its fourteen calls were exactly that.
 *
 * Not clamped. A stated delay longer than the agent's remaining deadline is
 * real information: the caller fails the agent instead of idling until timeout.
 */
export function parseRetryDelayMs(error: unknown): number | undefined {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!raw) return undefined;
  let seconds: number | undefined;
  try {
    const details = (JSON.parse(raw) as { error?: { details?: Array<Record<string, unknown>> } }).error?.details;
    const info = details?.find((detail) => String(detail['@type'] ?? '').endsWith('google.rpc.RetryInfo'));
    const stated = /^([\d.]+)s$/.exec(String(info?.retryDelay ?? ''));
    if (stated) seconds = Number(stated[1]);
  } catch { /* Not a JSON body. The human message below carries it too. */ }
  if (seconds === undefined) {
    const stated = /retry in ([\d.]+)s/i.exec(raw);
    if (stated) seconds = Number(stated[1]);
  }
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeUsage(usage?: GenerateContentResponseUsageMetadata) {
  const fields = {
    totalTokens: usage?.totalTokenCount,
    inputTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    thinkingTokens: usage?.thoughtsTokenCount,
    cachedInputTokens: usage?.cachedContentTokenCount,
  };
  // A partial breakdown cannot prove a total: keep the reservation unknown.
  // Cached input is already included in prompt/total; never add it again.
  return modelUsageSchema.parse({
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => isTokenCount(value))),
    status: isTokenCount(fields.totalTokens) ? 'reported' : 'unknown',
  });
}

function normalizeResponse(response: GenerateContentResponse, model: string): AgentResponse {
  const usage = normalizeUsage(response.usageMetadata);
  const candidate = response.candidates?.[0];
  const content = candidate?.content;
  const toolCalls: ToolCall[] = [];
  const text: string[] = [];
  const thoughts: string[] = [];
  for (const part of content?.parts ?? []) {
    if (part.text !== undefined && !part.thought) text.push(part.text);
    if (part.text && part.thought) thoughts.push(part.text);
    if (part.functionCall) {
      const call = part.functionCall;
      if (!call.name || (call.args !== undefined &&
          (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)))) {
        throw new ModelAdapterError('invalid_response', 'Gemini returned a malformed function call.', false, undefined, usage);
      }
      toolCalls.push({
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        arguments: structuredClone(call.args ?? {}),
      });
    }
  }
  if (!candidate && !response.promptFeedback?.blockReason) {
    throw new ModelAdapterError('invalid_response', 'Gemini returned no candidate or block reason.', false, undefined, usage);
  }
  if (!text.length && toolCalls.length === 0) {
    // Returning empty is legal, and the planner will treat it as an unusable
    // answer and retry — by which point the budget reservation is spent and the
    // failure surfaces as `token_exhausted`, several layers from the cause.
    reportProviderError?.({
      model,
      status: undefined,
      detail: `empty response: finishReason=${candidate?.finishReason ?? 'none'} ` +
        `blockReason=${response.promptFeedback?.blockReason ?? 'none'} usage=${usage.status}` +
        (usage.totalTokens === undefined ? '' : ` total=${usage.totalTokens}`) +
        (usage.thinkingTokens === undefined ? '' : ` thinking=${usage.thinkingTokens}`),
    });
  }
  return {
    ...(text.length ? { text: text.join('') } : {}),
    ...(thoughts.length ? { thoughts: thoughts.join('\n\n') } : {}),
    toolCalls,
    usage,
    ...(content ? { providerState: { provider: 'gemini', model, content: structuredClone(content) } satisfies GeminiState } : {}),
    ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
    ...(response.promptFeedback?.blockReason ? { blockReason: response.promptFeedback.blockReason } : {}),
  };
}

function safeError(error: unknown, signal?: AbortSignal, model = 'unknown'): ModelAdapterError {
  if (error instanceof ModelAdapterError) {
    // Report these as well. They are already safe to surface, but they are the
    // adapter refusing the provider's answer — which is exactly the case that
    // produced no log line at all and left a run to die on a later retry.
    if (error.code !== 'aborted') {
      reportProviderError?.({ model, status: error.status, detail: `${error.code}: ${error.message}` });
    }
    return error;
  }
  if (signal?.aborted) return new ModelAdapterError('aborted', 'Model operation was canceled.');
  const status = typeof error === 'object' && error !== null && 'status' in error &&
    typeof error.status === 'number' ? error.status : undefined;
  // Report the real cause to the log before it is collapsed into a code.
  reportProviderError?.({ model, status, detail: redactProviderDetail(error) });
  const retryDelayMs = parseRetryDelayMs(error);
  if (status === 429) {
    return new ModelAdapterError('rate_limited', 'Gemini request was rate limited.',
      true, status, { status: 'unknown' }, retryDelayMs);
  }
  return new ModelAdapterError('provider_error', 'Gemini request failed.',
    status === undefined || status === 408 || status >= 500, status, { status: 'unknown' }, retryDelayMs);
}
