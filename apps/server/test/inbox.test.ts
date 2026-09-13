import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listInboxResponseSchema } from '@app/contracts';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';
import { fakeSha, insertAgentInstance, insertBudget, insertDiscussionEntry, insertRun, insertTask } from './helpers.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t?.close(); });
async function inbox(workspaceId: string) {
  const res = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/inbox` });
  expect(res.statusCode, res.body).toBe(200);
  return listInboxResponseSchema.parse(res.json()).items;
}
async function question(workspaceId: string) {
  const db = t.handle.db;
  const taskId = await insertTask(db, workspaceId, { status: 'needs_input' });
  const runId = await insertRun(db, workspaceId, taskId, { status: 'needs_input' });
  await insertBudget(db, workspaceId, taskId, 'orchestrator');
  const agentId = await insertAgentInstance(db, workspaceId, taskId, runId);
  const deadline = new Date(Date.now() + 600_000);
  await db.updateTable('agent_instances').set({ status: 'needs_input', started_at: new Date(), deadline_at: deadline })
    .where('id', '=', agentId).execute();
  const entryId = await insertDiscussionEntry(db, workspaceId, taskId, { actor_type: 'agent', body: 'Which audience?' });
  await db.updateTable('tasks').set({ active_run_id: runId, discussion_seq: 1 }).where('id', '=', taskId).execute();
  const q = await db.insertInto('agent_questions').values({ workspace_id: workspaceId, task_id: taskId,
    run_id: runId, agent_instance_id: agentId, question_entry_id: entryId, expires_at: deadline })
    .returning('id').executeTakeFirstOrThrow();
  return { taskId, runId, questionId: q.id };
}
async function review(workspaceId: string, taskId: string, status: 'ready' | 'conflict' | 'stale' = 'ready') {
  return t.handle.db.insertInto('reviews').values({ workspace_id: workspaceId, task_id: taskId,
    task_version: 1, guidance_version: 1, main_sha: fakeSha('main'), human_sha: fakeSha('human'),
    context_hash: 'a'.repeat(64), candidate_sha: fakeSha('candidate'), status })
    .returning('id').executeTakeFirstOrThrow();
}

it('aggregates all four types once, ordered by issue time, without leaking another workspace', async () => {
  const db = t.handle.db;
  const { workspaceId } = await createWorkspaceViaApi(t.app);
  const other = await createWorkspaceViaApi(t.app);
  const q = await question(workspaceId);
  await question(other.workspaceId);
  const pending = await insertTask(db, workspaceId, { status: 'ready_for_review' });
  const r = await review(workspaceId, pending);
  const failed = await insertTask(db, workspaceId, { status: 'incomplete' });
  await insertRun(db, workspaceId, failed, { status: 'incomplete' });
  const blocked = await insertTask(db, workspaceId, { status: 'conflict' });
  await insertRun(db, workspaceId, blocked, { status: 'incomplete' });
  await review(workspaceId, blocked, 'conflict');
  const items = await inbox(workspaceId);
  expect(items.map((item) => item.type).sort()).toEqual(['blocker', 'failed_run', 'question', 'review']);
  expect(new Set(items.map((item) => item.id)).size).toBe(4);
  expect(items.find((item) => item.type === 'question')).toMatchObject({ questionId: q.questionId, summary: 'Which audience?' });
  expect(items.find((item) => item.type === 'review')?.reviewId).toBe(r.id);
  expect(items.map((item) => item.timestamp)).toEqual(items.map((item) => item.timestamp).sort().reverse());
  expect(await inbox(workspaceId)).toEqual(items);
  expect(await inbox(other.workspaceId)).toHaveLength(1);
});

it('only the dedicated answer resolves a question; foreign tasks and questions cannot be answered', async () => {
  const { workspaceId } = await createWorkspaceViaApi(t.app);
  const other = await createWorkspaceViaApi(t.app);
  const q = await question(workspaceId);
  const foreign = await question(other.workspaceId);
  const payload = { questionId: q.questionId, guestLabel: 'Contributor', body: 'New contributors', clientRequestId: randomUUID() };
  const comment = await t.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${q.taskId}/discussion`, payload });
  expect(comment.statusCode).toBe(201);
  expect(comment.json().question).toBeNull();
  expect(await inbox(workspaceId)).toHaveLength(1);
  for (const [ws, task] of [[other.workspaceId, q.taskId], [other.workspaceId, foreign.taskId]]) {
    const res = await t.app.inject({ method: 'POST', url: `/api/workspaces/${ws}/tasks/${task}/answer`, payload });
    expect(res.statusCode).toBe(404);
  }
  const answerPayload = { ...payload, clientRequestId: randomUUID() };
  const answer = await t.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${q.taskId}/answer`, payload: answerPayload });
  expect(answer.statusCode, answer.body).toBe(200);
  expect(answer.json().answerEntry.question.role).toBe('answer');
  expect(await inbox(workspaceId)).toEqual([]);
  expect(await inbox(other.workspaceId)).toHaveLength(1);
});

it('expires unanswered questions even before the sweeper updates their status', async () => {
  const { workspaceId } = await createWorkspaceViaApi(t.app);
  const q = await question(workspaceId);
  await t.handle.db.updateTable('agent_questions').set({ asked_at: new Date(Date.now() - 2000), expires_at: new Date(Date.now() - 1000) })
    .where('id', '=', q.questionId).execute();
  expect(await inbox(workspaceId)).toEqual([]);
});

it('removes applied reviews, resolved conflicts, canceled tasks and superseded failures', async () => {
  const db = t.handle.db;
  const { workspaceId } = await createWorkspaceViaApi(t.app);
  const taskId = await insertTask(db, workspaceId, { status: 'conflict' });
  const r = await review(workspaceId, taskId, 'conflict');
  expect((await inbox(workspaceId))[0]?.type).toBe('blocker');
  await db.updateTable('reviews').set({ status: 'ready' }).where('id', '=', r.id).execute();
  await db.updateTable('tasks').set({ status: 'ready_for_review' }).where('id', '=', taskId).execute();
  expect((await inbox(workspaceId))[0]?.type).toBe('review');
  // A rebuild in progress is still the same pending review, not a resolution.
  await db.updateTable('reviews').set({ status: 'building' }).where('id', '=', r.id).execute();
  expect(await inbox(workspaceId)).toMatchObject([{ id: `review:${taskId}`, type: 'review', reviewId: r.id }]);
  await db.updateTable('reviews').set({ status: 'applied' }).where('id', '=', r.id).execute();
  await db.updateTable('tasks').set({ status: 'awaiting_confirmation' }).where('id', '=', taskId).execute();
  expect(await inbox(workspaceId)).toEqual([]);
  const failed = await insertTask(db, workspaceId, { status: 'incomplete' });
  await insertRun(db, workspaceId, failed, { status: 'incomplete' });
  expect((await inbox(workspaceId))[0]?.type).toBe('failed_run');
  const retry = await t.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${failed}/retry`,
    payload: { expectedVersion: 1, clientRequestId: randomUUID() } });
  expect(retry.statusCode, retry.body).toBe(202);
  expect(await inbox(workspaceId)).toEqual([]);
  const q = await question(workspaceId);
  const cancel = await t.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${q.taskId}/cancel`, payload: {} });
  expect(cancel.statusCode).toBe(200);
  expect(await inbox(workspaceId)).toEqual([]);
});

it('uses explicit scheduler blockers only for the latest unresolved attempt, without double-counting failure', async () => {
  const db = t.handle.db;
  const { workspaceId } = await createWorkspaceViaApi(t.app);
  const taskId = await insertTask(db, workspaceId, { status: 'incomplete' });
  const runId = await insertRun(db, workspaceId, taskId, { status: 'incomplete' });
  for (let i = 0; i < 2; i++) await db.insertInto('task_events').values({ workspace_id: workspaceId, task_id: taskId,
    run_id: runId, type: 'agent.waiting', event_key: `blocked:${i}`, payload: { phase: 'scheduler', reason: 'blocked' } }).execute();
  expect((await inbox(workspaceId)).map((item) => item.type)).toEqual(['blocker']);
  await insertRun(db, workspaceId, taskId, { attempt: 2, status: 'incomplete' });
  expect((await inbox(workspaceId)).map((item) => item.type)).toEqual(['failed_run']);
  await db.updateTable('tasks').set({ status: 'completed' }).where('id', '=', taskId).execute();
  expect(await inbox(workspaceId)).toEqual([]);
});

it('covers the whole workspace beyond board pagination and validates workspace IDs', async () => {
  const { workspaceId } = await createWorkspaceViaApi(t.app);
  await t.handle.db.insertInto('tasks').values(Array.from({ length: 205 }, (_, i) => ({
    workspace_id: workspaceId, kind: 'agent_task' as const, title: `Review ${i}`, creator_guest_label: 'Guest', status: 'ready_for_review' as const,
  }))).execute();
  expect(await inbox(workspaceId)).toHaveLength(205);
  for (const [id, status] of [['bad-id', 400], [randomUUID(), 404]] as const) {
    const response = await t.app.inject({ method: 'GET', url: `/api/workspaces/${id}/inbox` });
    expect(response.statusCode).toBe(status);
  }
});
