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
  'gemini-2.5-pro': { minThinking: 128, maxThinking: 32768, maxOutput: 65536 },
  'gemini-2.5-flash': { minThinking: 0, maxThinking: 24576, maxOutput: 65536 },
};

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
        throw new ModelAdapterError('configuration', 'Configured model needs a verified token/thinking profile.');
      }
    }
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
      throw safeError(error, signal);
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
      thinkingConfig: { thinkingBudget, includeThoughts: false },
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
      throw safeError(error, signal);
    }
  }
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
  for (const part of content?.parts ?? []) {
    if (part.text !== undefined && !part.thought) text.push(part.text);
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
  return {
    ...(text.length ? { text: text.join('') } : {}),
    toolCalls,
    usage,
    ...(content ? { providerState: { provider: 'gemini', model, content: structuredClone(content) } satisfies GeminiState } : {}),
    ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
    ...(response.promptFeedback?.blockReason ? { blockReason: response.promptFeedback.blockReason } : {}),
  };
}

function safeError(error: unknown, signal?: AbortSignal): ModelAdapterError {
  if (error instanceof ModelAdapterError) return error;
  if (signal?.aborted) return new ModelAdapterError('aborted', 'Model operation was canceled.');
  const status = typeof error === 'object' && error !== null && 'status' in error &&
    typeof error.status === 'number' ? error.status : undefined;
  if (status === 429) return new ModelAdapterError('rate_limited', 'Gemini request was rate limited.', true, status);
  return new ModelAdapterError('provider_error', 'Gemini request failed.',
    status === undefined || status === 408 || status >= 500, status);
}
