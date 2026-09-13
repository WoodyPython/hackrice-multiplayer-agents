import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { LiveDocument } from '../../web/src/live-document.js';
import { startRuntime } from '../src/recovery/runtime.js';
import { buildApp } from '../src/http/app.js';
import { RecordingBroadcaster } from '../src/events/broadcaster.js';
import { connectTestDb, testDatabaseUrl } from './helpers.js';
import { testConfig } from './app-helpers.js';
import { SweepModel } from './sweep-model.js';

it('serves the app and carries live drafts and materials through parallel agents, review, apply, and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-sweep-'));
  const frontendRoot = join(root, 'web');
  await mkdir(join(frontendRoot, 'assets'), { recursive: true });
  await writeFile(join(frontendRoot, 'index.html'), '<!doctype html><main>Workspace application</main>');
  await writeFile(join(frontendRoot, 'assets', 'editor.worker-abc.js'), 'self.onmessage = () => {};');
  const adapter = new SweepModel();
  const broadcaster = new RecordingBroadcaster();
  const config = testConfig({ gitDataRoot: join(root, 'git'), DATABASE_URL: testDatabaseUrl(), bootId: randomUUID() });
  const options = { config, frontendRoot, modelAdapter: adapter, listen: { host: '127.0.0.1', port: 0 },
    applicationFactory: (deps: Parameters<typeof buildApp>[0]) => buildApp({ ...deps, broadcaster }) };
  let runtime = await startRuntime(options);
  const db = connectTestDb();
  const clients: LiveDocument[] = [];
  const address = () => `http://127.0.0.1:${(runtime.app.server.address() as { port: number }).port}`;
  async function api(path: string, body?: unknown, key?: string, expected = 200) {
    const res = await fetch(`${address()}/api/workspaces${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'x-owner-key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(expected);
    return json as any;
  }
  const peer = (workspaceId: string, taskId: string, draft: { id: string; epoch: number }) => {
    const client = new LiveDocument({ workspaceId, taskId, draftFileId: draft.id, epoch: draft.epoch },
      (url) => new WebSocket(url) as unknown as globalThis.WebSocket, address());
    clients.push(client); return client;
  };
  try {
    expect(await (await fetch(address())).text()).toContain('Workspace application');
    expect((await fetch(`${address()}/w/${randomUUID()}/tasks/${randomUUID()}`)).status).toBe(200);
    expect((await fetch(`${address()}/assets/editor.worker-abc.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${address()}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${address()}/api/not-a-route`)).status).toBe(404);
    const ws = await api('', { name: 'Complete runtime sweep' }, undefined, 201);
    const base = `/${ws.workspaceId}`;
    expect((await api(`${base}/files`)).files).toEqual([]);
    await api(`${base}/drafts/open`, { path: 'docs/broken.md', guestLabel: 'Sweep' }, undefined, 400);
    await api(`${base}/tasks`, { title: 'Invalid scope', creatorGuestLabel: 'Sweep', outputPaths: ['documents/a.pdf'] }, undefined, 400);
    const source = await api(`${base}/drafts/open`, { path: 'documents/source.md', guestLabel: 'Sweep' }, undefined, 201);
    const a = peer(ws.workspaceId, source.taskId, source.draftFile);
    const b = peer(ws.workspaceId, source.taskId, source.draftFile);
    await expect.poll(() => [a.state, b.state], { timeout: 30000 }).toEqual(['saved', 'saved']);
    a.doc.getText('content').insert(0, 'Captured shared source.\n');
    await expect.poll(() => b.doc.getText('content').toString()).toBe('Captured shared source.\n');
    await expect.poll(() => [a.state, b.state]).toEqual(['saved', 'saved']);
    const form = new FormData(); form.append('guestLabel', 'Sweep'); form.append('file', new Blob(['Material input.']), 'brief.txt');
    const uploaded = await fetch(`${address()}/api/workspaces${base}/materials`, { method: 'POST', body: form });
    expect(uploaded.status).toBe(201);
    const material = (await uploaded.json() as any).material;
    const task = await api(`${base}/tasks`, { title: 'Write both outputs', creatorGuestLabel: 'Sweep',
      outputPaths: ['documents/result.md', 'code/result.ts'], inputs: [{ draftFileId: source.draftFile.id }, { materialId: material.id }] }, undefined, 201);
    expect(adapter.requests).toEqual([]);
    const taskPath = `${base}/tasks/${task.id}`;
    const ownDraft = await api(`${taskPath}/drafts`, { path: 'documents/result.md' });
    const editor = peer(ws.workspaceId, task.id, ownDraft);
    await expect.poll(() => editor.state, { timeout: 30000 }).toBe('saved');
    editor.doc.getText('content').insert(0, 'Human starting text.\n');
    await expect.poll(() => editor.state).toBe('saved');
    await api(`${taskPath}/discussion`, { body: 'Before Start', guestLabel: 'Sweep', clientRequestId: randomUUID() }, undefined, 201);
    const start = { expectedVersion: 1, clientRequestId: randomUUID() };
    const started = await api(`${taskPath}/start`, start, undefined, 202);
    expect((await api(`${taskPath}/start`, start, undefined, 202)).runId).toBe(started.runId);
    await api(`${taskPath}/discussion`, { body: 'After Start', guestLabel: 'Sweep', clientRequestId: randomUUID() }, undefined, 201);
    await expect.poll(() => adapter.contexts.length, { timeout: 60000 }).toBe(1);
    b.doc.getText('content').insert(0, 'Later source edit.\n');
    await expect.poll(async () => (await api(taskPath)).status, { timeout: 120000 }).toBe('ready_for_review');
    expect(adapter.contexts[0]!.discussion.map((d) => d.body)).toEqual(['Before Start']);
    expect(adapter.contexts[0]!.sources).toContainEqual({ kind: 'draft', path: 'documents/source.md', draftFileId: source.draftFile.id, text: 'Captured shared source.\n' });
    expect(adapter.contexts[0]!.sources).toContainEqual(expect.objectContaining({ kind: 'material', text: 'Material input.' }));
    const readResults = adapter.requests.flatMap((r) => r.messages.flatMap((m) => m.role === 'tool' ? m.results : []));
    expect(readResults).toContainEqual(expect.objectContaining({ name: 'read_file', result: expect.objectContaining({ path: 'documents/source.md', text: 'Captured shared source.\n' }) }));
    expect((await api(`${base}/files`)).files).toEqual([]);
    expect(editor.doc.getText('content').toString()).toBe('Human starting text.\n');
    await expect.poll(() => broadcaster.sent.some((hint) => hint.taskId === task.id && hint.eventType === 'agent.completed')).toBe(true);
    const review = await api(`${taskPath}/review`, {});
    expect(review.changedFiles.map((f: { path: string }) => f.path).sort()).toEqual(['code/result.ts', 'documents/result.md']);
    const reviewPath = `${base}/reviews/${review.review.id}`;
    const assessed = await api(`${reviewPath}/assess`, {});
    expect(assessed.examinedSha).toBe(review.candidateSha);
    // Apply is deliberately not owner-gated: a contributor with no key applies,
    // and the owner's later call is the idempotent repeat. This assertion IS
    // the policy -- it previously required 403 here.
    const applied = await api(`${reviewPath}/apply`, { candidateSha: review.candidateSha });
    expect(applied.status).toBe('applied');
    expect((await api(`${reviewPath}/apply`, { candidateSha: review.candidateSha }, ws.ownerKey)).alreadyApplied).toBe(true);
    expect((await api(`${reviewPath}/apply`, { candidateSha: review.candidateSha }, ws.ownerKey)).alreadyApplied).toBe(true);
    await expect.poll(() => editor.state).toBe('closed');
    const approved = await api(`${base}/files`);
    expect(approved.files).toHaveLength(2);
    expect((await api(`${base}/files/content?path=documents%2Fresult.md`)).text).toContain('# Verified result');
    expect((await api(`${base}/history`)).entries).toHaveLength(1);
    const budgets = await db.db.selectFrom('task_agent_budgets').selectAll().where('task_id', '=', task.id).execute();
    expect(budgets.every((budget) => budget.reserved_tokens === 0 && budget.consumed_tokens > 0)).toBe(true);
    // A completed task can run again in the same process after its rooms closed.
    await db.db.updateTable('tasks').set({ status: 'completed' }).where('id', '=', task.id).execute();
    await api(`${taskPath}/start`, { expectedVersion: (await api(taskPath)).version, clientRequestId: randomUUID() }, undefined, 202);
    await expect.poll(async () => ['ready_for_review', 'incomplete', 'interrupted'].includes((await api(taskPath)).status), { timeout: 120000 }).toBe(true);
    expect((await api(taskPath)).status, JSON.stringify(adapter.requests.flatMap((r) => r.messages.flatMap((m) => m.role === 'tool' ? m.results.filter((result) => result.result.error) : [])))).toBe('ready_for_review');
    const nextReview = await api(`${taskPath}/review`, {});
    expect(nextReview.review.id).not.toBe(review.review.id);
    await api(`${base}/reviews/${nextReview.review.id}/apply`, { candidateSha: nextReview.candidateSha }, ws.ownerKey);
    expect(editor.state).toBe('closed');
    const rerunApproved = await api(`${base}/files`);
    for (const client of clients) client.destroy(); clients.length = 0;
    await runtime.close();
    runtime = await startRuntime({ ...options, config: { ...config, bootId: randomUUID() } });
    expect((await api(`${base}/files`)).mainSha).toBe(rerunApproved.mainSha);
    expect((await api(`${base}/history`)).entries).toHaveLength(2);
    expect((await api(taskPath)).status).toBe('awaiting_confirmation');
    await api(`${taskPath}/drafts`, { path: 'documents/new.md' }, undefined, 409);
    const reopened = await api(`${base}/drafts/open`, { path: 'documents/result.md', guestLabel: 'Sweep' }, undefined, 201);
    const restored = peer(ws.workspaceId, reopened.taskId, reopened.draftFile);
    await expect.poll(() => restored.state, { timeout: 30000 }).toBe('saved');
    expect(restored.doc.getText('content').toString()).toContain('# Verified result');
  } finally {
    for (const client of clients) client.destroy();
    await runtime.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
}, 240000);
