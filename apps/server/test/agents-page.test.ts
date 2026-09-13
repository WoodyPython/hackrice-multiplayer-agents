import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t?.close(); });

it('paginates the full workspace in stable order while task timestamps change', async () => {
  const { workspaceId } = await createWorkspaceViaApi(t.app, { name: 'Agent pagination' });
  const other = await createWorkspaceViaApi(t.app, { name: 'Other workspace' });
  const ids = [];
  for (let index = 0; index < 3; index++) {
    const task = await t.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks`,
      payload: { title: `Task ${index}`, creatorGuestLabel: 'Guest' } });
    expect(task.statusCode).toBe(201);
    ids.push(task.json().id as string);
  }
  ids.sort();
  const first = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/tasks?order=id&limit=2` });
  expect(first.statusCode).toBe(200);
  expect(first.json().tasks.map((task: { id: string }) => task.id)).toEqual(ids.slice(0, 2));
  // Reordering by updated_at between pages must not skip or repeat tasks.
  await t.handle.db.updateTable('tasks').set({ updated_at: new Date(Date.now() + 60_000) })
    .where('id', '=', ids[2]!).execute();
  const next = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/tasks?order=id&limit=2&afterId=${ids[1]}` });
  expect(next.json().tasks.map((task: { id: string }) => task.id)).toEqual(ids.slice(2));
  const foreign = await t.app.inject({ method: 'GET', url: `/api/workspaces/${other.workspaceId}/tasks?order=id&limit=2` });
  expect(foreign.json().tasks).toEqual([]);
  for (const suffix of ['agents', 'events', 'saved-outputs']) {
    const response = await t.app.inject({ method: 'GET', url: `/api/workspaces/${other.workspaceId}/tasks/${ids[0]}/${suffix}` });
    expect(response.statusCode, suffix).toBe(404);
  }
});

it('validates cursors and refuses missing workspaces', async () => {
  const { workspaceId } = await createWorkspaceViaApi(t.app, { name: 'Pagination validation' });
  for (const query of ['order=id&afterId=bad', `afterId=${randomUUID()}`, 'order=id&limit=201']) {
    const result = await t.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/tasks?${query}` });
    expect(result.statusCode).toBe(400);
  }
  const absent = await t.app.inject({ method: 'GET', url: `/api/workspaces/${randomUUID()}/tasks?order=id` });
  expect(absent.statusCode).toBe(404);
  expect(absent.json().error.code).toBe('WORKSPACE_NOT_FOUND');
});
