# C01: model adapters

Import from `models/index.ts`. These modules are server-only and perform no work
at import time. Create the production adapter with `createGeminiAdapter(config)`
when wiring agent execution. It requires `GEMINI_API_KEY`; other roles can still
run the server without constructing it.

`ORCHESTRATOR_MODEL` selects the orchestrator model. `WORKER_MODEL` selects the
model for analyst, writer, coder, and reviewer. The initial supported profiles
are `gemini-2.5-pro` and `gemini-2.5-flash`; either can be routed to either tier.
The optional `models/` prefix is accepted. Before adding another model, verify
its token-counting behavior, combined output ceiling, and thinking bounds, then
add its profile and tests. Model configuration stays out of frontend requests.

## Calling the interface

```ts
import { createGeminiAdapter, type AgentRequest } from './models/index.js';

const adapter = createGeminiAdapter(config);
const request: AgentRequest = {
  preset: 'writer',
  systemInstruction: 'Use the supplied sources. Identify unknown facts.',
  messages: [{ role: 'user', text: 'Draft an FAQ from these notes: ...' }],
};

const inputTokens = await adapter.countInput(request, signal);
// C02 reserves inputTokens + an output allowance atomically BEFORE generate.
// Do not mutate the request between counting and generating.
const response = await adapter.generate(request, {
  maxOutputTokens: 4096, // Includes thinking; not an additional text-only budget.
  thinkingBudget: 1024,
}, signal);
// Reconcile response.usage, then check live deadline/status before accepting work.
```

For a tool follow-up, append `{ role: 'assistant', response }` containing the
entire previous response, followed by `{ role: 'tool', results }`. Each result
contains `name`, `result` (an object), and `id` when the call supplied one. Group
parallel call results into the same turn. The original `providerState` is opaque
and JSON-serializable: preserve it on storage/reload. Never reconstruct it from
the display text or normalized tool calls. History from another model is rejected.

The adapter returns tool requests; it never executes them. C04 must validate
tool names, arguments, selected sources, and write scope before executing them.
`responseJsonSchema` enables structured JSON output for C03, which must still
parse and validate the result. `finishReason` and `blockReason` expose truncation
and safety outcomes; returned text alone is not evidence of completion.

## Accounting and cancellation boundaries

- One `generate` call makes at most one generation request. SDK retries and
  automatic function calling are disabled. Scheduling and backoff belong to
  application code.
- `maxOutputTokens` is the combined thinking/output ceiling. The optional
  thinking budget must fit within it. Without an explicit thinking allocation,
  the adapter uses one quarter of the output ceiling, clamped to model bounds.
- Provider total usage is preserved without adding component counts or cached
  input again. Missing total usage remains `unknown`, even with partial counters.
- Errors expose safe codes, HTTP status, retryability, and usage when available;
  raw provider errors and credentials are not retained.
- The abort signal reaches both counting and generation. A late response can
  still return usage for reconciliation. C02 must reject late effects using
  persisted status/deadline checks. This adapter does not enforce the task budget
  or start a ten-minute clock on its own.

The SDK is pinned to `@google/genai@2.22.0`. Its Developer API token-count
converter rejects system instructions and tools. Counting therefore uses the
SDK's `httpOptions.extraBody` with the REST API's full `generateContentRequest`;
the shorthand `contents` is cleared with JSON null. Transport tests compare the
actual count and generation bodies, including tool history and signatures.

References: [full-request token counting](https://ai.google.dev/api/tokens),
[SDK HTTP body extension](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpOptions.html),
[SDK retry options](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpRetryOptions.html),
[thinking and protocol state](https://ai.google.dev/gemini-api/docs/thinking),
[Pro limits](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro),
[Flash limits](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash).

## Verification and the fake adapter

From the repository root:

```sh
npm run test:models --workspace @app/server
npm run build
npm test
```

The focused suite needs neither PostgreSQL nor a Gemini key. It uses the real
SDK with a mocked HTTP transport. The full suite also runs the database tests.
No test makes a live provider call.

`FakeModelAdapter` implements the same interface with scripted steps:

```ts
const fake = new FakeModelAdapter([
  { inputTokens: 20, result: {
    text: 'Fixture answer', toolCalls: [],
    usage: { totalTokens: 35, status: 'reported' },
  } },
]);
```

Counting reads the next step without consuming it. Generation consumes one
step, including a scripted error. A step can also supply an async callback that
receives the abort signal to simulate delayed, canceled, or late billed work.
The `counts` and `calls` arrays record snapshots for assertions. Script exhaustion
throws; the fake never silently falls back to the real provider.
