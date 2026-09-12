import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startTaskResponseSchema } from '@app/contracts';
import { appendEvent } from '../src/events/service.js';
import { PgReviewStore } from '../src/runs/review-store.js';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';
import { fakeSha } from './helpers.js';
import { PgAgentLedger } from '../src/agents/ledger.js';
import { PgWorkerStore } from '../src/workers/store.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t?.close(); });
async function fixture() {
  const workspace = await createWorkspaceViaApi(t.app);
  const base = `/api/workspaces/${workspace.workspaceId}`;
  const task = (await t.app.inject({ method: 'POST', url: `${base}/tasks`,
    payload: { title: 'Regression', creatorGuestLabel: 'Guest' } })).json();
  return { ...workspace, base, taskId: task.id as string, url: `${base}/tasks/${task.id}` };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it('coalesces concurrent post requests and scopes discussion replays before reading them', async () => {
  const f = await fixture();
  const clientRequestId = randomUUID();
  const requests = await Promise.all([0, 1].map(() => t.app.inject({ method: 'POST', url: `${f.base}/tasks`,
    payload: { title: 'One task', creatorGuestLabel: 'Guest', clientRequestId } })));
  expect(requests.map((r) => r.statusCode)).toEqual([201, 201]);
  expect(new Set(requests.map((r) => r.json().id)).size).toBe(1);
  const messages = await Promise.all([0, 1].map(() => t.app.inject({ method: 'POST', url: `${f.url}/discussion`,
    payload: { body: 'One message', guestLabel: 'Guest', clientRequestId } })));
  expect(messages.map((r) => r.statusCode)).toEqual([201, 201]);
  expect(new Set(messages.map((r) => r.json().id)).size).toBe(1);
  const other = await createWorkspaceViaApi(t.app);
  const wrong = await t.app.inject({ method: 'POST', url: `/api/workspaces/${other.workspaceId}/tasks/${f.taskId}/discussion`,
    payload: { body: 'One message', guestLabel: 'Guest', clientRequestId } });
  expect(wrong.statusCode).toBe(404);
  expect(wrong.json().error.code).toBe('TASK_NOT_FOUND');
});

it('cancels an active incomplete attempt and returns a browser-valid retry response', async () => {
  const f = await fixture();
  const first = await t.app.inject({ method: 'POST', url: `${f.url}/start`, payload: { expectedVersion: 1, clientRequestId: randomUUID() } });
  await t.handle.db.updateTable('tasks').set({ status: 'incomplete' }).where('id', '=', f.taskId).execute();
  const stopped = await t.app.inject({ method: 'POST', url: `${f.url}/cancel`, payload: {} });
  expect(stopped.statusCode).toBe(200);
  expect(stopped.json()).toMatchObject({ status: 'canceled', activeRunId: null });
  expect(t.orchestration.canceled).toContainEqual({ workspaceId: f.workspaceId, taskId: f.taskId, runId: first.json().runId });
  const payload = { expectedVersion: 1, clientRequestId: randomUUID() };
  const retry = await t.app.inject({ method: 'POST', url: `${f.url}/retry`, payload });
  expect(retry.statusCode).toBe(202);
  expect(startTaskResponseSchema.parse(retry.json())).toMatchObject({ attempt: 2, taskStatus: 'planning', idempotentReplay: false });
  const replay = await t.app.inject({ method: 'POST', url: `${f.url}/retry`, payload });
  expect(replay.json()).toMatchObject({ runId: retry.json().runId, idempotentReplay: true });
});

it('replays only the answer attached to that question, without allocating another discussion sequence', async () => {
  const f = await fixture();
  const started = await t.app.inject({ method: 'POST', url: `${f.url}/start`, payload: { expectedVersion: 1, clientRequestId: randomUUID() } });
  const run = await t.handle.db.selectFrom('runs').selectAll().where('id', '=', started.json().runId).executeTakeFirstOrThrow();
  const ledger = new PgAgentLedger({ db: t.handle.db, bootId: run.boot_id });
  const worker = await ledger.createInstance({ runId: run.id, agentKey: 'writer', assignmentKey: 'writer', preset: 'writer', modelId: 'test' });
  await ledger.start(worker.id);
  const store = new PgWorkerStore(t.handle.db, ledger);
  const questionId = await store.ask(worker.id, 'Which format?', new AbortController().signal);
  const payload = { questionId, body: 'Markdown', guestLabel: 'Guest', clientRequestId: randomUUID() };
  const responses = await Promise.all([0, 1].map(() => t.app.inject({ method: 'POST', url: `${f.url}/answer`, payload })));
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(responses[1]!.json()).toEqual(responses[0]!.json());
  expect((await t.handle.db.selectFrom('tasks').select('discussion_seq').where('id', '=', f.taskId).executeTakeFirstOrThrow()).discussion_seq).toBe(2);
  await store.answer(worker.id, questionId, new AbortController().signal);
  const another = await store.ask(worker.id, 'Another question?', new AbortController().signal);
  const wrong = await t.app.inject({ method: 'POST', url: `${f.url}/answer`, payload: { ...payload, questionId: another } });
  expect(wrong.statusCode).toBe(409);
  expect(wrong.json().error.code).toBe('INVALID_STATE');
  expect((await t.handle.db.selectFrom('agent_questions').select('status').where('id', '=', another).executeTakeFirstOrThrow()).status).toBe('open');
});

it('serializes event allocation before a cursor can pass an uncommitted event', async () => {
  const f = await fixture();
  const inserted = gate(), commit = gate();
  let secondPid: number | undefined;
  let secondFinished = false;
  const first = t.handle.db.transaction().execute(async (trx) => {
    const event = await appendEvent(trx, { workspaceId: f.workspaceId, taskId: f.taskId, eventKey: 'first', type: 'agent.started' });
    inserted.release();
    await commit.promise;
    return event;
  });
  await inserted.promise;
  const second = t.handle.db.transaction().execute(async (trx) => {
    secondPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
    const result = await appendEvent(trx, { workspaceId: f.workspaceId, taskId: f.taskId, eventKey: 'second', type: 'agent.started' });
    secondFinished = true;
    return result;
  });
  try {
    await vi.waitFor(async () => {
      expect(secondPid).toBeDefined();
      const state = await t.handle.pool.query('select wait_event_type from pg_stat_activity where pid = $1', [secondPid]);
      expect(secondFinished || state.rows[0]?.wait_event_type === 'Lock').toBe(true);
    });
    expect(secondFinished).toBe(false);
    const visible = await t.handle.db.selectFrom('task_events').select('event_key').where('task_id', '=', f.taskId).execute();
    expect(visible.map((e) => e.event_key)).not.toContain('second');
  } finally {
    commit.release();
    await Promise.allSettled([first, second]);
  }
  const [a, b] = await Promise.all([first, second]);
  expect(Number(a.eventId)).toBeLessThan(Number(b.eventId));
  const page = await t.app.inject({ method: 'GET', url: `${f.url}/events?afterId=${a.eventId}` });
  expect(page.json().events.map((e: { id: string }) => e.id)).toEqual([b.eventId]);
});

it('invalidates current reviews on requirements/guidance changes while retaining applied history', async () => {
  const f = await fixture();
  const store = new PgReviewStore({ db: t.handle.db });
  const source = { taskVersion: 1, guidanceVersion: 1, mainSha: fakeSha('main'), humanSha: fakeSha('human'),
    resultSha: null, documentRevisions: {}, contextHash: 'context' };
  const create = () => store.create({ workspaceId: f.workspaceId, taskId: f.taskId, runId: null, source });
  const building = await create(), ready = await create(), applied = await create();
  await store.markReady(ready.id, fakeSha('candidate'));
  await store.markReady(applied.id, fakeSha('published'));
  await store.markApplied(applied.id);
  const revised = await t.app.inject({ method: 'PATCH', url: f.url, payload: { expectedVersion: 1, title: 'Revised' } });
  expect(revised.statusCode).toBe(200);
  expect((await store.read(building.id))!.status).toBe('stale');
  expect((await store.read(ready.id))!.status).toBe('stale');
  expect((await store.read(applied.id))!.status).toBe('applied');
  const next = await create();
  const headers = { 'x-owner-key': f.ownerKey };
  const renamed = await t.app.inject({ method: 'PATCH', url: f.base, headers, payload: { name: 'Renamed' } });
  expect(renamed.statusCode).toBe(200);
  expect((await store.read(next.id))!.status).toBe('building');
  const guidance = await t.app.inject({ method: 'PATCH', url: f.base, headers, payload: { guidance: 'New guidance' } });
  expect(guidance.statusCode).toBe(200);
  expect((await store.read(next.id))!.status).toBe('stale');
  expect((await store.read(applied.id))!.status).toBe('applied');
});

it('allows a material-link replay but blocks new attachments while Apply is pending', async () => {
  const f = await fixture();
  const materials = await t.handle.db.insertInto('materials').values([1, 2].map((n) => ({
    workspace_id: f.workspaceId, filename: `input${n}.txt`, object_key: randomUUID(),
    sha256: Buffer.alloc(32, n), byte_size: 1,
  }))).returning('id').execute();
  const attach = (id: string) => t.app.inject({ method: 'POST', url: `${f.url}/material-links`, payload: { materialId: id } });
  expect((await attach(materials[0]!.id)).statusCode).toBe(204);
  const review = await new PgReviewStore({ db: t.handle.db }).create({ workspaceId: f.workspaceId, taskId: f.taskId, runId: null,
    source: { taskVersion: 1, guidanceVersion: 1, mainSha: fakeSha('main'), humanSha: fakeSha('human'),
      resultSha: null, documentRevisions: {}, contextHash: 'context' } });
  await t.handle.db.insertInto('apply_operations').values({ workspace_id: f.workspaceId, review_id: review.id,
    expected_main_sha: fakeSha('main'), candidate_sha: fakeSha('candidate'), boot_id: randomUUID(), status: 'pending' }).execute();
  expect((await attach(materials[0]!.id)).statusCode).toBe(204);
  const refused = await attach(materials[1]!.id);
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe('RUN_INTERRUPTED');
  expect(await t.handle.db.selectFrom('material_links').select('id').where('task_id', '=', f.taskId).execute()).toHaveLength(1);
});
