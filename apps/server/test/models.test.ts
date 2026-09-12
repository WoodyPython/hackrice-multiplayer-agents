import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PRESETS } from '@app/contracts';
import { GenerateContentResponse, type Content } from '@google/genai';
import {
  createGeminiAdapter, GeminiAdapter, FakeModelAdapter, ModelAdapterError,
  type AgentRequest, type AgentResponse, type GeminiClient,
} from '../src/models/index.js';
import { normalizeUsage } from '../src/models/gemini.js';

const config = {
  GEMINI_API_KEY: 'test-only-secret',
  ORCHESTRATOR_MODEL: 'gemini-2.5-pro',
  WORKER_MODEL: 'gemini-2.5-flash',
};
const request: AgentRequest = {
  preset: 'writer',
  systemInstruction: 'Use only supplied sources.',
  messages: [{ role: 'user', text: 'Write a FAQ.' }],
};
const allowance = { maxOutputTokens: 1024, thinkingBudget: 128 };
const signal = () => new AbortController().signal;
const complete = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
  usageMetadata: { totalTokenCount: 35, promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 10 },
};

/** Exercises actual SDK serialization and retries; no network or credentials. */
function transport(...responses: Array<{ body: unknown; status?: number }>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected extra HTTP request');
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    body(index: number): Record<string, any> {
      const init = (fetch.mock.calls[index] as unknown as [string, RequestInit])[1];
      return JSON.parse(init.body as string);
    },
    url(index: number): string {
      return String((fetch.mock.calls[index] as unknown as [string])[0]);
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Gemini adapter through the real SDK', () => {
  it.each(['orchestrator', 'writer'] as const)('exposes a usable minimum output bound for %s', async (preset) => {
    const http = transport({ body: complete });
    const adapter = createGeminiAdapter(config);
    const profile = adapter.getModel(preset);
    expect(profile.minOutputTokens).toBe(preset === 'orchestrator' ? 129 : 1);
    await adapter.generate({ ...request, preset }, { maxOutputTokens: profile.minOutputTokens }, signal());
    expect(http.body(0).generationConfig.maxOutputTokens).toBe(profile.minOutputTokens);
    expect(profile.maxOutputTokens).toBe(65536);
  });

  it.each(AGENT_PRESETS)('routes %s using backend configuration', async (preset) => {
    const http = transport({ body: complete });
    await createGeminiAdapter(config).generate({ ...request, preset }, allowance, signal());
    const model = preset === 'orchestrator' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
    expect(http.url(0)).toContain(`/models/${model}:generateContent`);
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.body(0)).not.toHaveProperty('GEMINI_API_KEY');
  });

  it('honors changed routing and accepts the models/ resource prefix', async () => {
    const http = transport({ body: complete });
    const adapter = createGeminiAdapter({ ...config, WORKER_MODEL: 'models/gemini-2.5-pro' });
    await adapter.generate(request, allowance, signal());
    expect(http.url(0)).toContain('/models/gemini-2.5-pro:generateContent');
  });

  it('counts full input including system instruction, tools, schema, and tool history', async () => {
    const content: Content = { role: 'model', parts: [
      { functionCall: { id: 'call-1', name: 'read_file', args: { path: 'faq.md' } }, thoughtSignature: 'c2ln' },
    ] };
    const http = transport(
      { body: { candidates: [{ content, finishReason: 'STOP' }] } },
      { body: { totalTokens: 117 } },
      { body: complete },
    );
    const adapter = createGeminiAdapter(config);
    const response = await adapter.generate(request, allowance, signal());
    const followup: AgentRequest = {
      ...request,
      tools: [{ name: 'read_file', description: 'Read a scoped file.', parameters: {
        type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
      } }],
      responseJsonSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      messages: [...request.messages, { role: 'assistant', response }, {
        role: 'tool', results: [{ id: 'call-1', name: 'read_file', result: { text: 'A fact.' } }],
      }],
    };
    expect(await adapter.countInput(followup)).toBe(117);
    await adapter.generate(followup, allowance, signal());
    const counted = http.body(1).generateContentRequest;
    const generated = http.body(2);
    expect(http.body(1).contents).toBeNull();
    expect(counted.model).toBe('models/gemini-2.5-flash');
    expect(counted.contents).toEqual(generated.contents);
    expect(counted.systemInstruction).toEqual(generated.systemInstruction);
    expect(counted.tools).toEqual(generated.tools);
    expect(counted.generationConfig).toEqual({
      responseMimeType: generated.generationConfig.responseMimeType,
      responseJsonSchema: generated.generationConfig.responseJsonSchema,
    });
    expect(generated.contents[1]).toEqual(content);
    expect(generated.contents[2].parts[0].functionResponse).toEqual({
      id: 'call-1', name: 'read_file', response: { text: 'A fact.' },
    });
  });

  it('preserves all content parts and parallel tool calls without exposing thought text', async () => {
    const content = { role: 'model', parts: [
      { text: 'private thought', thought: true, thoughtSignature: 'dGhvdWdodA==' },
      { text: 'Checking ', thoughtSignature: 'dGV4dA==' },
      { functionCall: { id: 'a', name: 'read_file', args: { path: 'a.md' } }, thoughtSignature: 'YQ==' },
      { functionCall: { id: 'b', name: 'read_file', args: { path: 'b.md' } } },
      { text: 'sources.' },
    ] };
    const http = transport({ body: { ...complete, candidates: [{ content, finishReason: 'STOP' }] } }, { body: complete });
    const adapter = createGeminiAdapter(config);
    const result = await adapter.generate(request, allowance, signal());
    expect(result.text).toBe('Checking sources.');
    expect(result.toolCalls).toEqual([
      { id: 'a', name: 'read_file', arguments: { path: 'a.md' } },
      { id: 'b', name: 'read_file', arguments: { path: 'b.md' } },
    ]);
    // Even after persistence and normalized-field mutation, raw state wins.
    const saved: AgentResponse = JSON.parse(JSON.stringify(result));
    saved.text = 'changed display summary';
    saved.toolCalls[0]!.arguments.path = 'wrong.md';
    await adapter.generate({ ...request, messages: [...request.messages,
      { role: 'assistant', response: saved }, { role: 'tool', results: [
        { id: 'a', name: 'read_file', result: { text: 'A' } },
        { id: 'b', name: 'read_file', result: { text: 'B' } },
      ] },
    ] }, allowance, signal());
    expect(http.body(1).contents[1]).toEqual(content);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('sends one combined output ceiling and bounded thinking allocation', async () => {
    const http = transport({ body: complete });
    await createGeminiAdapter(config).generate(request, { maxOutputTokens: 1000 }, signal());
    expect(http.body(0).generationConfig).toMatchObject({
      candidateCount: 1, maxOutputTokens: 1000,
      thinkingConfig: { thinkingBudget: 250, includeThoughts: false },
    });
  });

  it.each([400, 429, 503])('does not retry HTTP %s or leak provider error text', async (status) => {
    const http = transport({ status, body: { error: { code: status, message: 'test-only-secret with prompt text' } } });
    const error = await createGeminiAdapter(config).generate(request, allowance, signal()).catch((e) => e);
    expect(error).toBeInstanceOf(ModelAdapterError);
    expect(error).toMatchObject({ code: status === 429 ? 'rate_limited' : 'provider_error', status,
      retryable: status !== 400, usage: { status: 'unknown' } });
    expect(String(error)).not.toContain('test-only-secret');
    expect(JSON.stringify(error)).not.toContain('prompt text');
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry token counting failures', async () => {
    const http = transport({ status: 503, body: { error: { code: 503, message: 'unavailable' } } });
    await expect(createGeminiAdapter(config).countInput(request)).rejects.toMatchObject({ code: 'provider_error' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { totalTokens: -1 }, { totalTokens: 1.2 }])('refuses missing or invalid token counts: %j', async (body) => {
    transport({ body });
    await expect(createGeminiAdapter(config).countInput(request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('returns truncation and safety outcomes explicitly', async () => {
    transport(
      { body: { ...complete, candidates: [{ content: { role: 'model', parts: [{ text: '{' }] }, finishReason: 'MAX_TOKENS' }] } },
      { body: { promptFeedback: { blockReason: 'SAFETY' } } },
    );
    const adapter = createGeminiAdapter(config);
    expect(await adapter.generate(request, allowance, signal())).toMatchObject({ text: '{', finishReason: 'MAX_TOKENS' });
    expect(await adapter.generate(request, allowance, signal())).toMatchObject({ blockReason: 'SAFETY', toolCalls: [], usage: { status: 'unknown' } });
  });

  it('retains reported usage on malformed model output', async () => {
    transport({ body: { usageMetadata: { totalTokenCount: 50 }, candidates: [
      { content: { role: 'model', parts: [{ functionCall: { args: { x: 1 } } }] } },
    ] } });
    await expect(createGeminiAdapter(config).generate(request, allowance, signal())).rejects.toMatchObject({
      code: 'invalid_response', usage: { totalTokens: 50, status: 'reported' },
    });
  });

  it('rejects an empty response while retaining usage', async () => {
    transport({ body: { usageMetadata: { totalTokenCount: 7 } } });
    await expect(createGeminiAdapter(config).generate(request, allowance, signal())).rejects.toMatchObject({
      code: 'invalid_response', usage: { totalTokens: 7, status: 'reported' },
    });
  });
});

describe('usage and call guards', () => {
  it('uses provider total including thinking without double-counting cached input', () => {
    expect(normalizeUsage({ totalTokenCount: 150, promptTokenCount: 100, candidatesTokenCount: 20,
      thoughtsTokenCount: 30, cachedContentTokenCount: 80 })).toEqual({
      totalTokens: 150, inputTokens: 100, outputTokens: 20, thinkingTokens: 30, cachedInputTokens: 80, status: 'reported',
    });
    expect(normalizeUsage({ promptTokenCount: 100, candidatesTokenCount: 20 })).toEqual({
      inputTokens: 100, outputTokens: 20, status: 'unknown',
    });
    expect(normalizeUsage({ totalTokenCount: 0 })).toEqual({ totalTokens: 0, status: 'reported' });
    expect(normalizeUsage({ totalTokenCount: NaN, thoughtsTokenCount: -1 })).toEqual({ status: 'unknown' });
    expect(normalizeUsage()).toEqual({ status: 'unknown' });
  });

  it('requires credentials only when creating the production adapter', () => {
    expect(() => createGeminiAdapter({ ...config, GEMINI_API_KEY: '' })).toThrow('GEMINI_API_KEY');
    expect(() => createGeminiAdapter({ ...config, WORKER_MODEL: 'unverified-model' })).toThrow('verified');
  });

  it.each([
    { maxOutputTokens: 0 }, { maxOutputTokens: -1 }, { maxOutputTokens: 1.5 },
    { maxOutputTokens: 65537 }, { maxOutputTokens: 128 },
    { maxOutputTokens: 1024, thinkingBudget: 0 }, { maxOutputTokens: 1024, thinkingBudget: 1024 },
  ])('rejects invalid Pro allowances before HTTP: %j', async (limits) => {
    const http = transport();
    await expect(createGeminiAdapter(config).generate({ ...request, preset: 'orchestrator' }, limits, signal()))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('rejects unsigned assistant history and cross-model state before HTTP', async () => {
    const http = transport();
    const adapter = createGeminiAdapter(config);
    for (const providerState of [undefined, { provider: 'gemini', model: 'gemini-2.5-pro', content: { role: 'model', parts: [] } }]) {
      await expect(adapter.generate({ ...request, messages: [...request.messages, { role: 'assistant', response: {
        text: 'Old answer', toolCalls: [], usage: { status: 'unknown' }, providerState,
      } }] }, allowance, signal())).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('never sends already canceled operations', async () => {
    const http = transport();
    const adapter = createGeminiAdapter(config);
    const controller = new AbortController();
    controller.abort('secret reason');
    await expect(adapter.generate(request, allowance, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    await expect(adapter.countInput(request, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('forwards cancellation to the transport without retrying', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('provider details')));
      controller.abort();
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(createGeminiAdapter(config).generate(request, allowance, controller.signal))
      .rejects.toMatchObject({ code: 'aborted', usage: { status: 'unknown' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns late reported usage so the ledger can reconcile it', async () => {
    const controller = new AbortController();
    const client: GeminiClient = { models: {
      countTokens: vi.fn(),
      generateContent: vi.fn(async () => {
        controller.abort();
        return Object.assign(new GenerateContentResponse(), complete);
      }),
    } };
    const result = await new GeminiAdapter(config, client).generate(request, allowance, controller.signal);
    expect(result.usage.totalTokens).toBe(35);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('scripted fake adapter', () => {
  const answer: AgentResponse = { text: 'Fixture', toolCalls: [], usage: { totalTokens: 9, status: 'reported' } };

  it('counts without consuming steps and scripts errors, unknown usage, and success', async () => {
    const fake = new FakeModelAdapter([
      { inputTokens: 5, result: new ModelAdapterError('rate_limited', 'Backoff', true) },
      { inputTokens: 7, result: { ...answer, usage: { status: 'unknown' } } },
      { inputTokens: 8, result: answer },
    ]);
    expect(await fake.countInput(request)).toBe(5);
    expect(await fake.countInput(request)).toBe(5);
    await expect(fake.generate(request, allowance, signal())).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await fake.countInput(request)).toBe(7);
    expect((await fake.generate(request, allowance, signal())).usage.status).toBe('unknown');
    const result = await fake.generate(request, allowance, signal());
    result.text = 'Changed';
    expect(answer.text).toBe('Fixture');
    expect(fake.calls).toHaveLength(3);
    expect(fake.counts).toHaveLength(3);
    await expect(fake.generate(request, allowance, signal())).rejects.toThrow('exhausted');
  });

  it('does not consume canceled calls and allows controlled delayed responses', async () => {
    const fake = new FakeModelAdapter([{ inputTokens: 5, result: async (receivedSignal) => {
      expect(receivedSignal.aborted).toBe(false);
      return answer;
    } }]);
    const controller = new AbortController();
    controller.abort();
    await expect(fake.generate(request, allowance, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(fake.calls).toHaveLength(0);
    expect(await fake.generate(request, allowance, signal())).toEqual(answer);
  });
});
