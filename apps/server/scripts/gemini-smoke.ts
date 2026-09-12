#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { createDb } from '../src/db/client.js';
import { AgentExecution, PgAgentLedger } from '../src/agents/index.js';
import { createGeminiAdapter } from '../src/models/gemini.js';
import { ModelAdapterError } from '../src/models/types.js';
import { PgTaskService } from '../src/tasks/service.js';
import { NullOrchestrationHook, postTaskRequestSchema } from '@app/contracts';

// Two synthetic provider requests, each capped at 256 generated tokens. No
// workspace documents, credentials, provider responses or exception text are logged.
loadDotenv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
loadDotenv({ quiet: true });
let stage = 'configuration';
async function main() {
  const config = { bootId: randomUUID(), DATABASE_URL: process.env.DATABASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ORCHESTRATOR_MODEL: process.env.ORCHESTRATOR_MODEL || 'gemini-2.5-pro',
    WORKER_MODEL: process.env.WORKER_MODEL || 'gemini-2.5-flash' };
  if (!config.DATABASE_URL) throw new Error('Database configuration required');
  const adapter = createGeminiAdapter(config);
  stage = 'database';
  const handle = createDb(config.DATABASE_URL);
  let workspaceId: string | undefined;
  const background: unknown[] = [];
  try {
    workspaceId = (await handle.db.insertInto('workspaces').values({ name: 'C08 synthetic smoke', owner_key_hash: Buffer.alloc(32) })
      .returning('id').executeTakeFirstOrThrow()).id;
    stage = 'task';
    const tasks = new PgTaskService({ db: handle.db, bootId: config.bootId, orchestration: new NullOrchestrationHook() });
    const task = await tasks.post(workspaceId, postTaskRequestSchema.parse({ title: 'Synthetic model verification', creatorGuestLabel: 'Smoke check' }));
    const { run } = await tasks.start(workspaceId, task.id, { expectedVersion: 1, clientRequestId: randomUUID() });
    const ledger = new PgAgentLedger({ db: handle.db, bootId: config.bootId });
    for (const preset of ['orchestrator', 'writer'] as const) {
      stage = `${preset}_instance`;
      const agent = await ledger.createInstance({ runId: run.id, agentKey: preset, assignmentKey: preset,
        preset, modelId: adapter.getModel(preset).modelId });
      const scope = await AgentExecution.open({ ledger, adapter, agentInstanceId: agent.id, onBackgroundError: (e) => background.push(e) });
      const timer = setTimeout(() => scope.close(), 60000);
      try {
        stage = `${preset}_generation`;
        const result = await scope.generate(randomUUID(), { preset, messages: [{ role: 'user', text: 'Reply with the word OK. This is a synthetic connectivity check.' }] }, { maxOutputTokens: 256 });
        if (result.usage.status !== 'reported' || result.usage.totalTokens === undefined || background.length) throw new Error('Unverified usage');
        console.log(JSON.stringify({ preset, usage: result.usage, providerStatePreserved: result.providerState !== undefined, status: 'passed' }));
      } finally { clearTimeout(timer); scope.close(); }
    }
  } finally {
    // Only this freshly created synthetic workspace is removed, with its rows.
    if (workspaceId) await handle.db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
    await handle.close();
  }
}
main().catch((error: unknown) => {
  const candidate = (error as { code?: unknown })?.code;
  console.error(JSON.stringify({ status: 'failed', stage,
    code: error instanceof ModelAdapterError ? error.code : typeof candidate === 'string' && /^[A-Z0-9_]{1,40}$/.test(candidate) ? candidate : 'smoke_failed' }));
  process.exitCode = 1;
});
