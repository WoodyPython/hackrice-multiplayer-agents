import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGENT_TIMEOUT_MS, TASK_AGENT_TOKEN_BUDGET } from '@app/contracts';
import { AgentExecution, PgAgentLedger } from '../src/agents/index.js';
import { FakeModelAdapter, ModelAdapterError, type AgentRequest, type AgentResponse } from '../src/models/index.js';
import type { DbHandle } from '../src/db/client.js';
import { PgDiscussionService } from '../src/discussion/service.js';
import { BOOT_ID, connectTestDb, insertWorkspace, insertTask, insertRun, insertDiscussionEntry } from './helpers.js';

let handle: DbHandle;
let workspaceId: string;
let clock = Date.now();
let ledger: PgAgentLedger;
const scopes: AgentExecution[] = [];
const backgroundErrors: unknown[] = [];
const profile = { modelId: 'fake', minOutputTokens: 1, maxOutputTokens: 65536 };
const request: AgentRequest = { preset: 'writer', messages: [{ role: 'user', text: 'Write an FAQ.' }] };
const result = (totalTokens = 30): AgentResponse => ({ text: 'Done.', toolCalls: [], usage: { status: 'reported', totalTokens } });

beforeAll(async () => {
  handle = connectTestDb();
  workspaceId = await insertWorkspace(handle.db, 'C02');
  ledger = new PgAgentLedger({ db: handle.db, bootId: BOOT_ID, now: () => new Date(clock) });
});
afterEach(async () => {
  scopes.splice(0).forEach((scope) => scope.close());
  vi.restoreAllMocks();
  expect(backgroundErrors.splice(0)).toEqual([]);
});
afterAll(async () => { await handle.close(); });

async function fixture(key = 'writer') {
  const taskId = await insertTask(handle.db, workspaceId, { status: 'working' });
  const runId = await insertRun(handle.db, workspaceId, taskId, { status: 'working' });
  await handle.db.updateTable('tasks').set({ active_run_id: runId }).where('id', '=', taskId).execute();
  const agent = await ledger.createInstance({ runId, agentKey: key, assignmentKey: key, preset: 'writer', modelId: 'fake' });
  return { taskId, runId, agent };
}
async function budget(taskId: string, agentKey = 'writer') {
  return handle.db.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', taskId)
    .where('agent_key', '=', agentKey).executeTakeFirstOrThrow();
}
async function reserve(id: string, requestKey = randomUUID(), inputTokens = 20, maxOutputTokens = 100) {
  return ledger.reserve({ agentInstanceId: id, requestKey, inputTokens, maxOutputTokens, profile });
}
async function open(agentId: string, adapter: FakeModelAdapter) {
  const scope = await AgentExecution.open({ ledger, adapter, agentInstanceId: agentId,
    now: () => clock, onBackgroundError: (error) => { backgroundErrors.push(error); } });
  scopes.push(scope);
  return scope;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('persistent reservations and reconciliation', () => {
  it('keeps a fresh budget for the same key in another task and another key in the same task', async () => {
    const a = await fixture();
    const b = await fixture();
    const peer = await ledger.createInstance({ runId: a.runId, agentKey: 'reviewer', assignmentKey: 'reviewer', preset: 'reviewer', modelId: 'fake' });
    await Promise.all([ledger.start(a.agent.id), ledger.start(b.agent.id), ledger.start(peer.id)]);
    await reserve(a.agent.id, 'a', 100, 63900);
    await ledger.recordUsage({ agentInstanceId: a.agent.id, requestKey: 'a', usage: { status: 'reported', totalTokens: 64000 } });
    await expect(reserve(a.agent.id, 'exhausted')).rejects.toMatchObject({ code: 'token_exhausted' });
    await expect(reserve(b.agent.id)).resolves.toMatchObject({ reservedTokens: 120 });
    await expect(reserve(peer.id)).resolves.toMatchObject({ reservedTokens: 120 });
    expect((await budget(b.taskId)).consumed_tokens).toBe(0);
    expect((await budget(a.taskId, 'reviewer')).token_budget).toBe(TASK_AGENT_TOKEN_BUDGET);
  });

  it('atomically prevents over-reservation across concurrent instances and rounds', async () => {
    for (let round = 0; round < 4; round++) {
      const f = await fixture();
      const peer = await ledger.createInstance({ runId: f.runId, agentKey: 'writer', assignmentKey: 'same-budget', preset: 'writer', modelId: 'fake' });
      await Promise.all([ledger.start(f.agent.id), ledger.start(peer.id)]);
      const reservations = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => reserve(i % 2 ? peer.id : f.agent.id, `r${i}`, 1000, 31000)));
      const accepted = reservations.filter((r) => r.status === 'fulfilled');
      expect(accepted).toHaveLength(2);
      expect(await budget(f.taskId)).toMatchObject({ reserved_tokens: 64000, consumed_tokens: 0 });
    }
  });

  it('counts reported totals once without adding thinking or cached components', async () => {
    const f = await fixture(); await ledger.start(f.agent.id); await reserve(f.agent.id, 'r');
    const usage = { status: 'reported' as const, totalTokens: 65, inputTokens: 20, outputTokens: 15, thinkingTokens: 30, cachedInputTokens: 10 };
    await Promise.all(Array.from({ length: 10 }, () => ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage })));
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 65, reserved_tokens: 0 });
  });

  it('holds unknown usage, then accepts a late total exactly once', async () => {
    const f = await fixture(); await ledger.start(f.agent.id); await reserve(f.agent.id, 'r');
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage: { status: 'unknown', inputTokens: 20 } });
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 0, reserved_tokens: 120 });
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage: { status: 'reported', totalTokens: 75 } });
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage: { status: 'unknown' } });
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 75, reserved_tokens: 0 });
  });

  it('retains a reservation when reported usage lacks a total', async () => {
    const f = await fixture(); await ledger.start(f.agent.id); await reserve(f.agent.id, 'r');
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage: { status: 'reported', inputTokens: 20, outputTokens: 5 } });
    expect((await budget(f.taskId)).reserved_tokens).toBe(120);
  });

  it('records over-budget late billing and prevents another call', async () => {
    const f = await fixture(); await ledger.start(f.agent.id); await reserve(f.agent.id, 'r');
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage: { status: 'reported', totalTokens: 65000 } });
    expect((await budget(f.taskId)).consumed_tokens).toBe(65000);
    await expect(reserve(f.agent.id)).rejects.toMatchObject({ code: 'token_exhausted' });
    expect((await handle.db.selectFrom('tasks').select('status').where('id', '=', f.taskId).executeTakeFirstOrThrow()).status).toBe('incomplete');
  });

  it('rejects duplicate request keys even when submitted concurrently', async () => {
    const f = await fixture(); await ledger.start(f.agent.id);
    const outcomes = await Promise.allSettled([reserve(f.agent.id, 'same'), reserve(f.agent.id, 'same')]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'duplicate_request' } });
    expect((await budget(f.taskId)).reserved_tokens).toBe(120);
  });

  it('derives a combined output allowance from remaining tokens and verified model bounds', async () => {
    const f = await fixture(); await ledger.start(f.agent.id);
    const allowance = await reserve(f.agent.id, 'first', 63900, 1000);
    expect(allowance).toEqual({ maxOutputTokens: 100, reservedTokens: 64000 });
    const g = await fixture(); await ledger.start(g.agent.id);
    await expect(ledger.reserve({ agentInstanceId: g.agent.id, requestKey: 'pro', inputTokens: 63872,
      profile: { ...profile, minOutputTokens: 129 } })).rejects.toMatchObject({ code: 'token_exhausted' });
    expect((await budget(g.taskId)).reserved_tokens).toBe(0);
  });

  it('rejects invalid counts and mismatched models before creating a call', async () => {
    const f = await fixture(); await ledger.start(f.agent.id);
    for (const n of [-1, 1.5, NaN, Infinity]) await expect(reserve(f.agent.id, randomUUID(), n)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(ledger.reserve({ agentInstanceId: f.agent.id, requestKey: 'mismatch', inputTokens: 1,
      profile: { ...profile, modelId: 'other' } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await budget(f.taskId)).reserved_tokens).toBe(0);
  });

  it('keeps consumed and unknown usage across manual attempts, model changes and service recreation', async () => {
    const f = await fixture(); await ledger.start(f.agent.id);
    await reserve(f.agent.id, 'known'); await reserve(f.agent.id, 'unknown');
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'known', usage: { status: 'reported', totalTokens: 50 } });
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'unknown', usage: { status: 'unknown' } });
    await handle.db.updateTable('runs').set({ status: 'incomplete' }).where('id', '=', f.runId).execute();
    const nextRun = await insertRun(handle.db, workspaceId, f.taskId, { attempt: 2, status: 'working' });
    await handle.db.updateTable('tasks').set({ active_run_id: nextRun }).where('id', '=', f.taskId).execute();
    const fresh = new PgAgentLedger({ db: handle.db, bootId: BOOT_ID, now: () => new Date(clock) });
    const retry = await fresh.createInstance({ runId: nextRun, agentKey: 'writer', assignmentKey: 'writer', preset: 'writer', modelId: 'changed-model' });
    clock += 1000;
    const started = await fresh.start(retry.id);
    expect(new Date(started.deadline_at!).getTime()).toBe(clock + AGENT_TIMEOUT_MS);
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 50, reserved_tokens: 120 });
    await expect(ledger.assertActive(f.agent.id)).rejects.toMatchObject({ code: 'inactive' });
    // Old attempt can report billing, but cannot write results into the new run.
    await fresh.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'unknown', usage: { status: 'reported', totalTokens: 60 } });
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 110, reserved_tokens: 0 });
  });

  it('keeps an exhausted logical agent exhausted in a fresh manual attempt', async () => {
    const f = await fixture(); await ledger.start(f.agent.id); await reserve(f.agent.id, 'r');
    await ledger.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage: { status: 'reported', totalTokens: 64000 } });
    await expect(reserve(f.agent.id)).rejects.toMatchObject({ code: 'token_exhausted' });
    await handle.db.updateTable('runs').set({ status: 'incomplete' }).where('id', '=', f.runId).execute();
    const nextRun = await insertRun(handle.db, workspaceId, f.taskId, { attempt: 2, status: 'working' });
    await handle.db.updateTable('tasks').set({ active_run_id: nextRun }).where('id', '=', f.taskId).execute();
    const retry = await ledger.createInstance({ runId: nextRun, agentKey: 'writer', assignmentKey: 'writer', preset: 'writer', modelId: 'fake' });
    clock += 1000;
    const scope = await open(retry.id, new FakeModelAdapter([{ inputTokens: 1, result: result() }]));
    expect(scope.deadlineAt).toBe(clock + AGENT_TIMEOUT_MS);
    await expect(scope.generate('retry', request)).rejects.toMatchObject({ code: 'token_exhausted' });
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 64000, reserved_tokens: 0 });
  });
});

describe('fixed deadlines and guarded results', () => {
  it('commits question expiry on a late human answer and serializes it with deadline enforcement', async () => {
    const discussion = new PgDiscussionService({ db: handle.db });
    for (const concurrent of [false, true, true, true]) {
      clock = Date.now() - AGENT_TIMEOUT_MS - 1000;
      const f = await fixture(); const agent = await ledger.start(f.agent.id);
      const entry = await insertDiscussionEntry(handle.db, workspaceId, f.taskId, { actor_type: 'agent', guest_label: null });
      const question = await handle.db.insertInto('agent_questions').values({ workspace_id: workspaceId,
        task_id: f.taskId, run_id: f.runId, agent_instance_id: f.agent.id,
        question_entry_id: entry, expires_at: agent.deadline_at! }).returning('id').executeTakeFirstOrThrow();
      clock = Date.now();
      const answer = discussion.answer(workspaceId, f.taskId, {
        questionId: question.id, body: 'Late answer', guestLabel: 'Guest',
      });
      const outcomes = await Promise.allSettled([answer,
        ...(concurrent ? [ledger.enforceDeadline({ agentInstanceId: f.agent.id })] : [])]);
      expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { code: expect.stringMatching(/^(AGENT_TIMED_OUT|QUESTION_NOT_OPEN)$/) } });
      if (concurrent) expect(outcomes[1]).toMatchObject({ status: 'fulfilled' });
      expect(await handle.db.selectFrom('agent_questions').select(['status', 'answer_entry_id'])
        .where('id', '=', question.id).executeTakeFirstOrThrow()).toEqual({ status: 'expired', answer_entry_id: null });
    }
  });

  it('does not start a clock while waiting on prerequisites and never extends it on restart', async () => {
    const f = await fixture();
    const prereq = await ledger.createInstance({ runId: f.runId, agentKey: 'analyst', assignmentKey: 'analyst', preset: 'analyst', modelId: 'fake' });
    await handle.db.insertInto('agent_dependencies').values({ run_id: f.runId, agent_id: f.agent.id, prerequisite_agent_id: prereq.id }).execute();
    await expect(ledger.start(f.agent.id)).rejects.toMatchObject({ code: 'prerequisites_pending' });
    const pending = await handle.db.selectFrom('agent_instances').selectAll().where('id', '=', f.agent.id).executeTakeFirstOrThrow();
    expect(pending.started_at).toBeNull(); expect(pending.deadline_at).toBeNull();
    await handle.db.updateTable('agent_instances').set({ status: 'completed' }).where('id', '=', prereq.id).execute();
    const first = await ledger.start(f.agent.id);
    clock += 5000;
    const again = await ledger.start(f.agent.id);
    expect(again.deadline_at).toEqual(first.deadline_at);
    expect(new Date(first.deadline_at!).getTime() - new Date(first.started_at!).getTime()).toBe(600000);
  });

  it('rejects results at exactly 600 seconds, preserving earlier checkpoints', async () => {
    const f = await fixture(); await ledger.start(f.agent.id);
    const sha = 'a'.repeat(40);
    await ledger.withActiveWrite(f.agent.id, async (trx, agent) => {
      await trx.updateTable('agent_instances').set({ result_sha: sha }).where('id', '=', agent.id).execute();
    });
    clock += 600000;
    const write = vi.fn();
    await expect(ledger.withActiveWrite(f.agent.id, write)).rejects.toMatchObject({ code: 'timed_out' });
    expect(write).not.toHaveBeenCalled();
    const row = await handle.db.selectFrom('agent_instances').selectAll().where('id', '=', f.agent.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'timed_out', result_sha: sha });
  });

  it('rolls back a database write that crosses the deadline inside its transaction', async () => {
    const f = await fixture(); await ledger.start(f.agent.id);
    await expect(ledger.withActiveWrite(f.agent.id, async (trx) => {
      await trx.updateTable('agent_instances').set({ result_sha: 'b'.repeat(40) }).where('id', '=', f.agent.id).execute();
      clock += AGENT_TIMEOUT_MS;
    })).rejects.toMatchObject({ code: 'timed_out' });
    expect(await handle.db.selectFrom('agent_instances').select(['status', 'result_sha']).where('id', '=', f.agent.id).executeTakeFirstOrThrow())
      .toEqual({ status: 'timed_out', result_sha: null });
  });

  it('expires open questions and emits one event across concurrent deadline sweeps', async () => {
    const f = await fixture(); const agent = await ledger.start(f.agent.id);
    const entry = await insertDiscussionEntry(handle.db, workspaceId, f.taskId, { actor_type: 'agent', guest_label: null });
    await handle.db.insertInto('agent_questions').values({ workspace_id: workspaceId, task_id: f.taskId,
      run_id: f.runId, agent_instance_id: f.agent.id, question_entry_id: entry, expires_at: agent.deadline_at! }).execute();
    await handle.db.updateTable('agent_instances').set({ status: 'needs_input' }).where('id', '=', f.agent.id).execute();
    clock += AGENT_TIMEOUT_MS;
    await Promise.all([ledger.sweepDeadlines(), ledger.enforceDeadline({ agentInstanceId: f.agent.id })]);
    expect((await handle.db.selectFrom('agent_questions').select('status').where('agent_instance_id', '=', f.agent.id).executeTakeFirstOrThrow()).status).toBe('expired');
    expect(await handle.db.selectFrom('task_events').select('id').where('task_id', '=', f.taskId).where('type', '=', 'agent.timed_out').execute()).toHaveLength(1);
  });

  it('refuses canceled, superseded and old-boot results while accepting their usage', async () => {
    for (const kind of ['canceled', 'superseded', 'boot'] as const) {
      const f = await fixture(); await ledger.start(f.agent.id); await reserve(f.agent.id, 'r');
      if (kind === 'canceled') await handle.db.updateTable('runs').set({ status: 'canceled' }).where('id', '=', f.runId).execute();
      if (kind === 'superseded') await handle.db.updateTable('tasks').set({ active_run_id: null }).where('id', '=', f.taskId).execute();
      const current = kind === 'boot' ? new PgAgentLedger({ db: handle.db, bootId: randomUUID() }) : ledger;
      await expect(current.withActiveWrite(f.agent.id, async () => 'late')).rejects.toMatchObject({ code: 'inactive' });
      await current.recordUsage({ agentInstanceId: f.agent.id, requestKey: 'r', usage: { status: 'reported', totalTokens: 10 } });
      expect((await budget(f.taskId)).consumed_tokens).toBe(10);
    }
  });
});

describe('budgeted model execution', () => {
  it('refuses a second provider call for the same key after successful settlement', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([
      { inputTokens: 20, result: result() }, { inputTokens: 20, result: result() },
    ]);
    const scope = await open(f.agent.id, adapter);
    await scope.generate('once', request, { maxOutputTokens: 100 });
    await expect(scope.generate('once', request, { maxOutputTokens: 100 })).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(adapter.calls).toHaveLength(1);
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 30, reserved_tokens: 0 });
  });

  it('releases a reservation only when generation provably never started', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20, result: result() }]);
    const scope = await open(f.agent.id, adapter);
    const realReserve = ledger.reserve.bind(ledger);
    vi.spyOn(ledger, 'reserve').mockImplementationOnce(async (input) => {
      const reserved = await realReserve(input);
      scope.close();
      return reserved;
    });
    await expect(scope.generate('never-sent', request)).rejects.toMatchObject({ code: 'canceled' });
    await scope.drain();
    expect(adapter.calls).toHaveLength(0);
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 0, reserved_tokens: 0 });
  });

  it('counts the exact immutable request and derives the generation allowance', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 63000, result: result(63200) }]);
    const scope = await open(f.agent.id, adapter);
    const original: AgentRequest = { ...structuredClone(request), systemInstruction: 'system',
      tools: [{ name: 'read', description: 'Read a source', parameters: { type: 'object' } }], responseJsonSchema: { type: 'object' } };
    const expected = structuredClone(original);
    const pending = scope.generate('r', original, { maxOutputTokens: 2000 });
    original.messages.push({ role: 'user', text: 'injected later' });
    await expect(pending).resolves.toMatchObject({ text: 'Done.' });
    expect(adapter.counts).toEqual([expected]);
    expect(adapter.calls).toEqual([{ request: expected, limits: { maxOutputTokens: 1000 } }]);
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 63200, reserved_tokens: 0 });
  });

  it('recounts repeated context and retains budget/deadline across provider retries', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([
      { inputTokens: 20, result: new ModelAdapterError('rate_limited', 'Rate limited', true) },
      { inputTokens: 20, result: result(40) },
    ]);
    const scope = await open(f.agent.id, adapter); const deadline = scope.deadlineAt;
    await expect(scope.generate('attempt1', request, { maxOutputTokens: 100 })).rejects.toMatchObject({ code: 'rate_limited' });
    clock += 2000;
    await scope.generate('attempt2', request, { maxOutputTokens: 100 });
    expect(adapter.counts).toHaveLength(2);
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 40, reserved_tokens: 120 });
    expect(scope.deadlineAt).toBe(deadline);
    expect(new Date((await ledger.start(f.agent.id)).deadline_at!).getTime()).toBe(deadline);
  });

  it('records reported usage carried by a failed response', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 20,
      result: new ModelAdapterError('invalid_response', 'Malformed response', false, undefined, { status: 'reported', totalTokens: 55 }) }]);
    const scope = await open(f.agent.id, adapter);
    await expect(scope.generate('r', request)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 55, reserved_tokens: 0 });
  });

  it('never generates if counting fails or consumes the remaining allowance', async () => {
    const f = await fixture(); const adapter = new FakeModelAdapter([{ inputTokens: 64000, result: result() }]);
    const scope = await open(f.agent.id, adapter);
    const count = vi.spyOn(adapter, 'countInput').mockRejectedValueOnce(new ModelAdapterError('provider_error', 'count failed'));
    await expect(scope.generate('count-fail', request)).rejects.toMatchObject({ code: 'provider_error' });
    count.mockRestore();
    await expect(scope.generate('no-room', request)).rejects.toMatchObject({ code: 'token_exhausted' });
    expect(adapter.calls).toHaveLength(0);
    expect((await budget(f.taskId)).reserved_tokens).toBe(0);
  });

  it('returns promptly at the timer deadline and reconciles a provider that ignores abort', async () => {
    const f = await fixture(); await ledger.start(f.agent.id);
    // Resume near the deadline; allow real DB round trips before the timer fires.
    clock += AGENT_TIMEOUT_MS - 1000;
    const late = deferred<AgentResponse>(); const sent = deferred<void>();
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: async () => { sent.resolve(); return late.promise; } }]);
    const scope = await open(f.agent.id, adapter);
    const call = scope.generate('r', request, { maxOutputTokens: 100 });
    const outcome = expect(call).rejects.toMatchObject({ code: 'timed_out' });
    await sent.promise;
    clock += 1000;
    await outcome;
    expect(scope.signal.aborted).toBe(true);
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 0, reserved_tokens: 120 });
    late.resolve(result(80)); await scope.drain();
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 80, reserved_tokens: 0 });
    expect((await handle.db.selectFrom('agent_instances').select('status').where('id', '=', f.agent.id).executeTakeFirstOrThrow()).status).toBe('timed_out');
  });

  it('aborts a pending token count without making a generation or reservation', async () => {
    const f = await fixture(); await ledger.start(f.agent.id); clock += AGENT_TIMEOUT_MS - 1000;
    const adapter = new FakeModelAdapter([{ inputTokens: 20, result: result() }]);
    const counting = deferred<number>(); const entered = deferred<void>();
    vi.spyOn(adapter, 'countInput').mockImplementation(async () => { entered.resolve(); return counting.promise; });
    const scope = await open(f.agent.id, adapter);
    const call = scope.generate('r', request); const outcome = expect(call).rejects.toMatchObject({ code: 'timed_out' });
    await entered.promise; clock += 1000; await outcome;
    counting.resolve(20); await scope.drain();
    expect(adapter.calls).toHaveLength(0); expect((await budget(f.taskId)).reserved_tokens).toBe(0);
  });

  it('includes tool/human waiting in the same deadline and rejects late completion', async () => {
    const f = await fixture(); await ledger.start(f.agent.id); clock += AGENT_TIMEOUT_MS - 1000;
    const scope = await open(f.agent.id, new FakeModelAdapter([]));
    const wait = deferred<string>(); const entered = deferred<void>();
    const waiting = scope.run(async () => { entered.resolve(); return wait.promise; });
    const outcome = expect(waiting).rejects.toMatchObject({ code: 'timed_out' });
    await entered.promise; clock += 1000; await outcome;
    wait.resolve('too late'); await scope.drain();
  });

  it('rejects late responses after cancel but retains known usage', async () => {
    const f = await fixture(); const late = deferred<AgentResponse>(); const sent = deferred<void>();
    const scope = await open(f.agent.id, new FakeModelAdapter([{ inputTokens: 20, result: async () => { sent.resolve(); return late.promise; } }]));
    const call = scope.generate('r', request); const outcome = expect(call).rejects.toMatchObject({ code: 'canceled' });
    await sent.promise; scope.close(); await outcome;
    late.resolve(result(60)); await scope.drain();
    expect(await budget(f.taskId)).toMatchObject({ consumed_tokens: 60, reserved_tokens: 0 });
  });
});
