import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { LIVE_MESSAGE_ACK, LIVE_TEXT_NAME, liveRoomPath, reviewDetailSchema, type ReviewDetail } from '@app/contracts';
import { startRuntime } from '../src/recovery/runtime.js';
import { PgDraftStore } from '../src/drafts/store.js';
import { PgReviewStore } from '../src/runs/review-store.js';
import { hashOwnerKey } from '../src/workspaces/owner-key.js';
import { connectTestDb, insertTask, insertWorkspace, insertRun, testDatabaseUrl } from './helpers.js';
import { testConfig } from './app-helpers.js';
import { appendEvent } from '../src/events/service.js';

let db: ReturnType<typeof connectTestDb>, root: string, runtime: Awaited<ReturnType<typeof startRuntime>>;
let workspaceId: string, taskId: string;
const ownerKey = 'd07-owner-key-for-tests-only';
const path = 'documents/shared.md';
const peers: Array<{ provider: WebsocketProvider; doc: Y.Doc }> = [];
beforeEach(async () => {
  db = connectTestDb(); root = await mkdtemp(join(tmpdir(), 'd07-apply-'));
  workspaceId = await insertWorkspace(db.db);
  await db.db.updateTable('workspaces').set({ owner_key_hash: hashOwnerKey(ownerKey) }).where('id', '=', workspaceId).execute();
  taskId = await insertTask(db.db, workspaceId, { kind: 'manual_edit', manual_source_path: path });
  runtime = await startRuntime({ config: testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl() }), listen: { host: '127.0.0.1', port: 0 } });
  await runtime.git.checkpoint({ workspaceId, taskId, files: [{ path, text: 'approved by review\n' }, { path: 'code/example.ts', text: 'export const answer = 42;\n' }] });
});
afterEach(async () => {
  for (const peer of peers.splice(0)) { peer.provider.destroy(); peer.doc.destroy(); }
  vi.restoreAllMocks(); await runtime?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
});
async function prepare() {
  return reviewDetailSchema.parse(await runtime.reviews.prepare(workspaceId, taskId));
}
const apply = (review: ReviewDetail, key: string | undefined = ownerKey) => runtime.app.inject({ method: 'POST',
  url: `/api/workspaces/${workspaceId}/reviews/${review.review.id}/apply`, payload: { candidateSha: review.candidateSha },
  headers: key === undefined ? {} : { 'x-owner-key': key } });
async function connect() {
  const draft = await new PgDraftStore({ db: db.db }).openForTask(workspaceId, taskId, path);
  const base = `ws://127.0.0.1:${(runtime.app.server.address() as { port: number }).port}`;
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(base, liveRoomPath({ workspaceId, taskId, draftFileId: draft.id, epoch: draft.epoch }).slice(1), doc,
    { WebSocketPolyfill: WebSocket, disableBc: true });
  provider.messageHandlers[LIVE_MESSAGE_ACK] = () => {};
  peers.push({ provider, doc });
  await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 10_000 });
  return { provider, doc, draft, text: doc.getText(LIVE_TEXT_NAME) };
}

describe('D07 owner apply', { timeout: 60_000 }, () => {
  it.each(['candidate', 'expected', 'ambiguous'] as const)('D08 reconciles %s main before attaching transport', async (outcome) => {
    const peer = await connect();
    const review = await prepare();
    const store = new PgReviewStore({ db: db.db });
    await store.begin({ workspaceId, reviewId: review.review.id, candidateSha: review.candidateSha,
      expectedMainSha: review.review.source.mainSha, bootId: randomUUID() });
    let main = review.review.source.mainSha;
    if (outcome !== 'expected') {
      main = outcome === 'candidate' ? review.candidateSha : (await runtime.git.checkpoint({ workspaceId,
        taskId: randomUUID(), files: [{ path, text: 'unrelated' }] })).commitSha;
      await runtime.git.applyExpected({ workspaceId, expectedMainSha: review.review.source.mainSha, candidateSha: main });
    }
    peer.provider.destroy();
    await runtime.close();
    runtime = await startRuntime({ config: testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl(), bootId: randomUUID() }),
      listen: { host: '127.0.0.1', port: 0 }, attachLiveDocuments: async (server) => {
        expect(server.listening).toBe(false);
        expect((await store.readOperation(review.review.id))!.status).toBe(outcome === 'candidate' ? 'applied' : outcome === 'expected' ? 'pending' : 'ambiguous');
        return { close: async () => {} };
      } });
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(main);
    await expect(runtime.collaboration.acquire({ workspaceId, taskId, draftFileId: peer.draft.id, epoch: peer.draft.epoch }))
      .rejects.toMatchObject({ code: outcome === 'candidate' ? 'DOCUMENT_EPOCH_CLOSED' : 'RUN_INTERRUPTED' });
    if (outcome === 'candidate') {
      expect((await apply(review)).json().alreadyApplied).toBe(true);
      expect(await runtime.reviews.reconcilePreviousApplies()).toEqual({ applied: 0, pending: 0, ambiguous: 0 });
      expect(await db.db.selectFrom('task_events').select('id').where('task_id', '=', taskId).where('type', '=', 'task.applied').execute()).toHaveLength(1);
    } else if (outcome === 'expected') {
      expect((await apply(review)).statusCode).toBe(200);
    }
  });

  it('lets a contributor with no owner key apply', async () => {
    // Apply is deliberately no longer owner-gated (see LocalReviewService.apply):
    // possession of the workspace link is the whole permission. A contributor
    // with no key, and one holding the wrong key, both succeed. Both assertions
    // previously expected 403 and ARE the policy, not incidental setup --
    // restoring them silently would restore the old rule.
    const review = await prepare();
    const absent = await runtime.app.inject({ method: 'POST',
      url: `/api/workspaces/${workspaceId}/reviews/${review.review.id}/apply`, payload: { candidateSha: review.candidateSha } });
    expect(absent.statusCode, absent.body).toBe(200);
    expect(absent.json().alreadyApplied).toBe(false);
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.candidateSha);

    // A wrong key is not rejected either -- the key is simply never consulted.
    const wrong = await apply(review, 'wrong');
    expect(wrong.statusCode, wrong.body).toBe(200);
    expect(wrong.json().alreadyApplied).toBe(true);

    // Settings stay owner-only: this change widened apply, nothing else.
    const settings = await runtime.app.inject({ method: 'PATCH', url: `/api/workspaces/${workspaceId}`,
      payload: { guidance: 'No key supplied.' } });
    expect(settings.statusCode).toBe(403);
    expect(settings.json().error.code).toBe('OWNER_KEY_REQUIRED');
  });

  it('publishes the exact multi-file candidate once', async () => {
    const review = await prepare();
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.review.source.mainSha);
    const results = await Promise.all([apply(review), apply(review), apply(review)]);
    for (const result of results) expect(result.statusCode, result.body).toBe(200);
    expect(results.map((r) => r.json().alreadyApplied).sort()).toEqual([false, true, true]);
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.candidateSha);
    expect((await db.db.selectFrom('tasks').select('status').where('id', '=', taskId).executeTakeFirstOrThrow()).status).toBe('awaiting_confirmation');
    expect((await new PgReviewStore({ db: db.db }).read(review.review.id))!.status).toBe('applied');
    expect(await db.db.selectFrom('apply_operations').select('id').where('review_id', '=', review.review.id).execute()).toHaveLength(1);
    expect(await db.db.selectFrom('task_events').select('id').where('task_id', '=', taskId).where('type', '=', 'task.applied').execute()).toHaveLength(1);
    for (const file of [path, 'code/example.ts']) expect((await runtime.git.readText({ workspaceId, target: { kind: 'commit', commitSha: review.candidateSha }, path: file, allowedPaths: [file] })).text).not.toBeNull();
  });

  it.each(['task', 'guidance', 'human', 'main', 'candidate', 'extra_document'] as const)('refuses changed %s without publication', async (change) => {
    const review = await prepare();
    if (change === 'task') await db.db.updateTable('tasks').set({ version: 2 }).where('id', '=', taskId).execute();
    if (change === 'guidance') await db.db.updateTable('workspaces').set({ guidance_version: 2 }).where('id', '=', workspaceId).execute();
    if (change === 'human') await runtime.git.checkpoint({ workspaceId, taskId, files: [{ path, text: 'newer' }] });
    if (change === 'main') {
      const next = await runtime.git.checkpoint({ workspaceId, taskId: randomUUID(), files: [{ path, text: 'other task' }] });
      await runtime.git.applyExpected({ workspaceId, expectedMainSha: review.review.source.mainSha, candidateSha: next.commitSha });
    }
    if (change === 'candidate') review.candidateSha = review.review.source.mainSha;
    if (change === 'extra_document') await new PgDraftStore({ db: db.db }).openForTask(workspaceId, taskId, path);
    const before = (await runtime.git.initialize(workspaceId)).mainSha;
    const response = await apply(review); expect(response.statusCode, response.body).toBe(409);
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(before);
  });

  it('marks accepted typing stale before persistence, including edit-and-undo', async () => {
    const peer = await connect(); const review = await prepare();
    peer.text.insert(0, 'x'); peer.text.delete(0, 1);
    await vi.waitFor(async () => expect((await new PgReviewStore({ db: db.db }).read(review.review.id))!.status).toBe('stale'));
    expect((await apply(review)).statusCode).toBe(409);
    expect(await db.db.selectFrom('task_events').select('id').where('task_id', '=', taskId).where('type', '=', 'review.stale').execute()).toHaveLength(1);
    expect(peer.text.toString()).toBe('approved by review\n');
  });

  it('invalidates a candidate-less build without violating the schema', async () => {
    const ready = await prepare();
    const building = await new PgReviewStore({ db: db.db }).create({ workspaceId, taskId, runId: null, source: ready.review.source });
    await runtime.reviews.invalidate({ taskId, reason: 'test:1' });
    expect(await new PgReviewStore({ db: db.db }).read(building.id)).toMatchObject({ status: 'stale', candidateSha: null });
  });

  it('checks unloaded persisted revisions and detects changed or missing documents', async () => {
    const drafts = new PgDraftStore({ db: db.db });
    const draft = await drafts.openForTask(workspaceId, taskId, path);
    const review = await prepare();
    const request = { taskId, documentRevisions: review.review.source.documentRevisions };
    expect(await runtime.collaboration.isCurrent(request)).toBe(true);
    await db.db.updateTable('draft_files').set({ persisted_revision: 1 }).where('id', '=', draft.id).execute();
    expect(await runtime.collaboration.isCurrent(request)).toBe(false);
    await drafts.closeEpoch(workspaceId, taskId);
    expect(await runtime.collaboration.isCurrent(request)).toBe(false);
  });

  it('retains accepted edits and rejects Apply even when stale-event persistence fails', async () => {
    const peer = await connect(); const review = await prepare();
    const acquired = await runtime.collaboration.acquire({ workspaceId, taskId, draftFileId: peer.draft.id, epoch: peer.draft.epoch });
    vi.spyOn(runtime.reviews, 'invalidate').mockRejectedValue(new Error('injected invalidation failure'));
    try {
      peer.text.insert(0, 'retained ');
      await vi.waitFor(() => expect(acquired.room.revision).toBeGreaterThan(0));
      expect(await runtime.collaboration.isCurrent({ taskId, documentRevisions: review.review.source.documentRevisions })).toBe(false);
      expect((await apply(review)).statusCode).not.toBe(200);
      expect(acquired.room.doc.getText(LIVE_TEXT_NAME).toString()).toContain('retained ');
      expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.review.source.mainSha);
    } finally { acquired.release(); }
  });

  it('fans out a typing burst without waiting for database guards or review persistence', async () => {
    const a = await connect(), b = await connect();
    const originalWritable = runtime.collaboration.assertWritable;
    let releaseWritable!: () => void, releaseInvalidation!: () => void, enteredInvalidation!: () => void;
    const writableBlocked = new Promise<void>((resolve) => { releaseWritable = resolve; });
    const invalidationBlocked = new Promise<void>((resolve) => { releaseInvalidation = resolve; });
    const invalidationEntered = new Promise<void>((resolve) => { enteredInvalidation = resolve; });
    const writable = vi.fn(async () => writableBlocked);
    runtime.collaboration.assertWritable = writable;
    const invalidate = vi.spyOn(runtime.reviews, 'invalidate').mockImplementation(async () => {
      enteredInvalidation();
      await invalidationBlocked;
    });

    try {
      const start = a.text.length;
      a.text.insert(start, 'a');
      await invalidationEntered;
      for (const character of ' low-latency burst') a.text.insert(a.text.length, character);

      await vi.waitFor(() => expect(b.text.toString()).toBe(a.text.toString()), { timeout: 1_000 });
      expect(writable).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledTimes(1);

      releaseInvalidation();
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    } finally {
      releaseWritable();
      releaseInvalidation();
      runtime.collaboration.assertWritable = originalWritable;
    }
  });

  it('rejects typing queued after the Apply gate without modifying the candidate', async () => {
    const peer = await connect(); const review = await prepare();
    peer.provider.on('connection-close', () => { peer.provider.shouldConnect = false; });
    const acquired = await runtime.collaboration.acquire({ workspaceId, taskId, draftFileId: peer.draft.id, epoch: peer.draft.epoch });
    let entered!: () => void, release!: () => void;
    const atPublish = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const original = runtime.git.withApply.bind(runtime.git);
    vi.spyOn(runtime.git, 'withApply').mockImplementation((workspace, callback) => original(workspace, (scope) => callback({ ...scope,
      publish: async (expected, candidate) => { entered(); await resume; return scope.publish(expected, candidate); },
    })));
    const request = Promise.resolve(apply(review));
    try {
      await atPublish;
      peer.text.insert(0, 'late unsent text ');
      await vi.waitFor(() => expect(acquired.room.busy).toBe(true));
    } finally { release(); }
    try {
      const response = await request; expect(response.statusCode, response.body).toBe(200);
      await vi.waitFor(() => expect(acquired.room.closed).toBe(true));
      expect(acquired.room.doc.getText(LIVE_TEXT_NAME).toString()).toBe('approved by review\n');
      expect(peer.text.toString()).toContain('late unsent text');
    } finally { acquired.release(); }
  });

  it('retries a pending operation still at expected main', async () => {
    const review = await prepare();
    const store = new PgReviewStore({ db: db.db });
    await store.begin({ workspaceId, reviewId: review.review.id, candidateSha: review.candidateSha, expectedMainSha: review.review.source.mainSha, bootId: randomUUID() });
    const response = await apply(review); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().alreadyApplied).toBe(false);
  });

  it.each([false, true])('checks the completed agent result at Apply (changed=%s)', async (changed) => {
    taskId = await insertTask(db.db, workspaceId, { status: 'working' });
    const capture = await runtime.git.checkpoint({ workspaceId, taskId, files: [{ path, text: 'agent baseline' }] });
    const runId = await insertRun(db.db, workspaceId, taskId, { status: 'completed' });
    await runtime.git.createResult({ workspaceId, runId, baseSha: capture.commitSha });
    await db.db.updateTable('runs').set({ input_snapshot_sha: capture.commitSha, result_head_sha: capture.commitSha, context_manifest: {
      taskVersion: 1, guidanceVersion: 1, discussionCutoffSeq: 0, materials: [], approvedPaths: [],
      approvedCommitSha: (await runtime.git.initialize(workspaceId)).mainSha, draftCheckpointSha: capture.commitSha, draftFileHashes: {},
    } }).where('id', '=', runId).execute();
    const review = await prepare();
    if (changed) await db.db.updateTable('runs').set({ result_head_sha: review.review.source.mainSha }).where('id', '=', runId).execute();
    const response = await apply(review); expect(response.statusCode, response.body).toBe(changed ? 409 : 200);
  });

  it('rejects removal of a reviewed material and cross-workspace Apply', async () => {
    const material = await db.db.insertInto('materials').values({ workspace_id: workspaceId, filename: 'reference.txt', object_key: randomUUID(),
      sha256: Buffer.alloc(32, 1), byte_size: 1, guest_label: 'Guest' }).returning('id').executeTakeFirstOrThrow();
    await db.db.insertInto('material_links').values({ workspace_id: workspaceId, task_id: taskId, material_id: material.id }).execute();
    const review = await prepare();
    const other = await insertWorkspace(db.db);
    const cross = await runtime.app.inject({ method: 'POST', url: `/api/workspaces/${other}/reviews/${review.review.id}/apply`,
      payload: { candidateSha: review.candidateSha }, headers: { 'x-owner-key': ownerKey } });
    expect(cross.statusCode).toBe(404);
    await db.db.updateTable('materials').set({ deleted_at: new Date() }).where('id', '=', material.id).execute();
    expect((await apply(review)).statusCode).toBe(409);
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.review.source.mainSha);
  });

  it('closes both editing peers and retains the closed epoch as history', async () => {
    const a = await connect(), b = await connect(); const review = await prepare();
    const codes: number[] = [];
    for (const peer of [a, b]) peer.provider.on('connection-close', (event: { code: number } | null) => { if (event) codes.push(event.code); peer.provider.shouldConnect = false; });
    const response = await apply(review); expect(response.statusCode, response.body).toBe(200);
    await vi.waitFor(() => expect(codes).toEqual([4409, 4409]));
    const drafts = new PgDraftStore({ db: db.db });
    expect((await drafts.load(workspaceId, a.draft.id))!.draftFile.status).toBe('closed');
    await expect(runtime.collaboration.acquire({ workspaceId, taskId, draftFileId: a.draft.id, epoch: a.draft.epoch })).rejects.toMatchObject({ code: 'DOCUMENT_EPOCH_CLOSED' });
    const next = await drafts.openNextEpoch(workspaceId, taskId, path);
    expect(next.id).not.toBe(a.draft.id); expect(next.epoch).toBe(a.draft.epoch + 1);
    expect((await apply(review)).json().alreadyApplied).toBe(true);
  });

  it('keeps published rooms closed after finalization fails and reconciles an authorized repeat', async () => {
    const peer = await connect(); const review = await prepare();
    // A ready candidate can remain valid when the task displays conflict;
    // recovery must use the same input checks as the original publication.
    await db.db.updateTable('tasks').set({ status: 'conflict' }).where('id', '=', taskId).execute();
    peer.provider.on('connection-close', () => { peer.provider.shouldConnect = false; });
    // Force a failure after Git has moved, inside the final transaction.
    await db.pool.query(`create function d07_fail_apply() returns trigger language plpgsql as $$ begin if NEW.task_id = '${taskId}' and NEW.type = 'task.applied' then raise exception 'injected'; end if; return NEW; end $$`);
    await db.pool.query('create trigger d07_fail_apply before insert on task_events for each row execute function d07_fail_apply()');
    try {
      expect((await apply(review)).statusCode).toBe(500);
      expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.candidateSha);
      expect((await new PgReviewStore({ db: db.db }).readOperation(review.review.id))!.status).toBe('pending');
      for (const [method, suffix, payload] of [
        ['PATCH', '', { expectedVersion: 1, title: 'New requirements after publication' }],
        ['POST', '/start', { expectedVersion: 1, clientRequestId: randomUUID() }],
        ['POST', '/retry', { expectedVersion: 1, clientRequestId: randomUUID(), savedOutputs: [] }],
      ] as const) {
        const mutation = await runtime.app.inject({ method, url: `/api/workspaces/${workspaceId}/tasks/${taskId}${suffix}`, payload });
        expect(mutation.statusCode, mutation.body).toBe(409);
        expect(mutation.json().error.code).toBe('RUN_INTERRUPTED');
      }
      expect(await db.db.selectFrom('runs').select('id').where('task_id', '=', taskId).execute()).toEqual([]);
      expect((await db.db.selectFrom('tasks').select('version').where('id', '=', taskId).executeTakeFirstOrThrow()).version).toBe(1);
      const guidance = await runtime.app.inject({ method: 'PATCH', url: `/api/workspaces/${workspaceId}`,
        headers: { 'x-owner-key': ownerKey }, payload: { guidance: 'New guidance after publication' } });
      expect(guidance.statusCode, guidance.body).toBe(409);
      expect(guidance.json().error.code).toBe('RUN_INTERRUPTED');
      const material = await db.db.insertInto('materials').values({ workspace_id: workspaceId, filename: 'reference.txt',
        object_key: randomUUID(), sha256: Buffer.alloc(32, 2), byte_size: 1, guest_label: 'Guest' }).returning('id').executeTakeFirstOrThrow();
      const attachment = await runtime.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${taskId}/material-links`,
        payload: { materialId: material.id } });
      expect(attachment.statusCode, attachment.body).toBe(409);
      expect(attachment.json().error.code).toBe('RUN_INTERRUPTED');
      expect(await db.db.selectFrom('material_links').select('id').where('task_id', '=', taskId).execute()).toEqual([]);
      // The published room stays permanently closed. The pending operation
      // blocks new work, but it must not mask the identity of this old epoch.
      await expect(runtime.collaboration.acquire({ workspaceId, taskId, draftFileId: peer.draft.id, epoch: peer.draft.epoch })).rejects.toMatchObject({ code: 'DOCUMENT_EPOCH_CLOSED' });
    } finally {
      await db.pool.query('drop trigger d07_fail_apply on task_events'); await db.pool.query('drop function d07_fail_apply()');
    }
    const response = await apply(review); expect(response.statusCode, response.body).toBe(200); expect(response.json().alreadyApplied).toBe(true);
  });

  it('stops an ambiguous pending operation without overwriting main', async () => {
    const review = await prepare(); const store = new PgReviewStore({ db: db.db });
    await store.begin({ workspaceId, reviewId: review.review.id, candidateSha: review.candidateSha, expectedMainSha: review.review.source.mainSha, bootId: randomUUID() });
    const other = await runtime.git.checkpoint({ workspaceId, taskId: randomUUID(), files: [{ path, text: 'other' }] });
    await runtime.git.applyExpected({ workspaceId, candidateSha: other.commitSha, expectedMainSha: review.review.source.mainSha });
    const response = await apply(review); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('RUN_INTERRUPTED');
    expect((await store.readOperation(review.review.id))!.status).toBe('ambiguous');
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(other.commitSha);
  });

  it('does not overwrite newer task state while reconciling a published receipt', async () => {
    const review = await prepare(), store = new PgReviewStore({ db: db.db });
    await store.begin({ workspaceId, reviewId: review.review.id, candidateSha: review.candidateSha,
      expectedMainSha: review.review.source.mainSha, bootId: randomUUID() });
    await runtime.git.applyExpected({ workspaceId, expectedMainSha: review.review.source.mainSha, candidateSha: review.candidateSha });
    // Simulate state left by a pre-guard runtime. Public mutations now reject it.
    await db.db.updateTable('tasks').set({ version: 2, title: 'Unreviewed requirements' }).where('id', '=', taskId).execute();
    expect(await runtime.reviews.reconcilePreviousApplies()).toEqual({ applied: 0, pending: 0, ambiguous: 1 });
    expect((await store.readOperation(review.review.id))!.status).toBe('ambiguous');
    expect(await db.db.selectFrom('tasks').select(['version', 'status', 'title']).where('id', '=', taskId).executeTakeFirstOrThrow())
      .toEqual({ version: 2, status: 'ready_for_review', title: 'Unreviewed requirements' });
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.candidateSha);
  });

  it('rechecks a task mutation that wins the task lock before Apply intent', async () => {
    const review = await prepare(), store = new PgReviewStore({ db: db.db });
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const mutation = db.db.transaction().execute(async (trx) => {
      await trx.selectFrom('tasks').select('id').where('id', '=', taskId).forUpdate().executeTakeFirstOrThrow();
      locked(); await hold;
      await trx.updateTable('tasks').set({ version: 2 }).where('id', '=', taskId).execute();
      // The event's workspace FK must remain compatible with begin's workspace
      // lock while begin waits for this task writer.
      await appendEvent(trx, { workspaceId, taskId, type: 'task.requirements_changed',
        eventKey: `mutation-before-apply:${taskId}`, payload: { version: 2 } });
    });
    await ready;
    const pending = store.begin({ workspaceId, reviewId: review.review.id, candidateSha: review.candidateSha,
      expectedMainSha: review.review.source.mainSha, bootId: randomUUID() }).catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => {
        const blocked = await db.pool.query("select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%tasks%for update%'");
        expect(blocked.rowCount).toBeGreaterThan(0);
      });
    } finally { release(); await mutation; }
    expect(await pending).toMatchObject({ code: 'REVIEW_STALE' });
    expect(await store.readOperation(review.review.id)).toBeUndefined();
    expect((await runtime.git.initialize(workspaceId)).mainSha).toBe(review.review.source.mainSha);
  });
});
