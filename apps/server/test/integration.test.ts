import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { reviewDetailSchema } from '@app/contracts';
import { startRuntime } from '../src/recovery/runtime.js';
import { connectTestDb, testDatabaseUrl } from './helpers.js';
import { testConfig, authenticateRuntime } from './app-helpers.js';

/**
 * B08 acceptance: workspace/object scoping, owner-key isolation, material
 * reuse, version guards, and discussion persistence — each checked *through a
 * real sequence* rather than in isolation.
 *
 * Every property below already has a unit test somewhere in B01–B07. What is
 * not covered anywhere else is whether they still hold once a workspace has
 * been used: a task posted, a material attached and reused, a draft edited and
 * checkpointed, a review prepared and applied. A property that holds on an
 * empty database and fails on a used one is the kind this ticket exists to
 * find.
 *
 * Driven through `startRuntime` and HTTP rather than the stores, deliberately.
 * Scoping and the owner key are enforced at the route, and `buildTestApp` does
 * not even register the review routes — anything asserted below the HTTP layer
 * would be asserting something the real server does not do.
 *
 * The flow uses a **manual-edit** task. Section 2.5: such a task "does not need
 * agent execution… the owner applies it through the same Git review path", so
 * the whole sequence runs with no model provider involved. The agent-side
 * guards are checked separately, against a run that starts but does not plan.
 */

let db: ReturnType<typeof connectTestDb>;
let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;

/** A workspace created the way a person creates one, so the key is real. */
interface Space {
  id: string;
  ownerKey: string;
}

beforeEach(async () => {
  db = connectTestDb();
  root = await mkdtemp(join(tmpdir(), 'b08-'));
  runtime = await startRuntime({
    config: testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl() }),
    listen: { host: '127.0.0.1', port: 0 },
  });
  await authenticateRuntime(runtime.app, db.db);
});

afterEach(async () => {
  await runtime?.close();
  await db?.close();
  await rm(root, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------

function multipart(
  fields: Record<string, string>,
  file: { name: string; content: string },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----b08${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  chunks.push(Buffer.from(file.content));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const app = (): FastifyInstance => runtime.app;

async function createSpace(name: string): Promise<Space> {
  const res = await app().inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name, purpose: 'B08' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { id: body.workspaceId, ownerKey: body.ownerKey };
}

async function postTask(space: Space, title: string, kind = 'agent_task') {
  const res = await app().inject({
    method: 'POST',
    url: `/api/workspaces/${space.id}/tasks`,
    payload: { kind, title, creatorGuestLabel: 'Guest Cedar' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function uploadMaterial(
  space: Space,
  content: string,
  fields: Record<string, string> = {},
) {
  const { payload, headers } = multipart(
    { guestLabel: 'Guest Cedar', ...fields },
    { name: 'brief.md', content },
  );
  return app().inject({
    method: 'POST',
    url: `/api/workspaces/${space.id}/materials`,
    payload,
    headers,
  });
}

async function comment(space: Space, taskId: string, body: string) {
  const res = await app().inject({
    method: 'POST',
    url: `/api/workspaces/${space.id}/tasks/${taskId}/discussion`,
    payload: { body, guestLabel: 'Guest Cedar', clientRequestId: randomUUID() },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/**
 * Runs the whole sequence once and hands back what it produced.
 *
 * Manual-edit, so no provider is involved: open the document, checkpoint the
 * live text, prepare a review, apply it as owner.
 */
async function usedWorkspace(name: string, apply = true) {
  const space = await createSpace(name);
  const path = 'documents/brief.md';

  const open = await app().inject({
    method: 'POST',
    url: `/api/workspaces/${space.id}/drafts/open`,
    payload: { path, guestLabel: 'Guest Cedar' },
  });
  expect(open.statusCode).toBe(201);
  const taskId: string = open.json().taskId;

  const material = (await uploadMaterial(space, 'the brief\n', { taskId })).json();
  await comment(space, taskId, 'First thought.');

  await runtime.git.checkpoint({
    workspaceId: space.id,
    taskId,
    files: [{ path, text: 'written together\n' }],
  });
  const review = reviewDetailSchema.parse(
    await runtime.reviews.prepare(space.id, taskId),
  );

  if (apply) {
    const applied = await app().inject({
      method: 'POST',
      url: `/api/workspaces/${space.id}/reviews/${review.review.id}/apply`,
      payload: { candidateSha: review.candidateSha },
      headers: { 'x-owner-key': space.ownerKey },
    });
    expect(applied.statusCode).toBe(200);
  }

  return { space, taskId, path, materialId: material.material.id as string, review };
}

// --- 1. scoping ------------------------------------------------------------

describe('workspace and object scoping survive a completed flow', { timeout: 90_000 }, () => {
  it('refuses every one of another workspace objects, as absent rather than forbidden', async () => {
    const used = await usedWorkspace('Owner space');
    const intruder = await createSpace('Intruder space');

    // Each of these is a real, existing object — in the other workspace.
    const reads = [
      `/tasks/${used.taskId}`,
      `/tasks/${used.taskId}/discussion`,
      `/tasks/${used.taskId}/drafts`,
      `/tasks/${used.taskId}/events`,
      `/tasks/${used.taskId}/agents`,
      `/tasks/${used.taskId}/reviews`,
      `/tasks/${used.taskId}/materials`,
      `/tasks/${used.taskId}/saved-outputs`,
      `/materials/${used.materialId}`,
      `/materials/${used.materialId}/meta`,
      `/reviews/${used.review.review.id}`,
      `/reviews/${used.review.review.id}/diff`,
    ];
    for (const suffix of reads) {
      const res = await app().inject({
        method: 'GET',
        url: `/api/workspaces/${intruder.id}${suffix}`,
      });
      // Section 11.4: the workspace in the path IS the access check, and there
      // is no identity to deny — so a foreign object is absent, never refused.
      // A 403 here would leak that the object exists.
      expect(
        res.statusCode,
        `${suffix} answered ${res.statusCode}`,
      ).toBe(404);
    }
  });

  it('keeps the listings of a used workspace out of a fresh one', async () => {
    await usedWorkspace('Busy space');
    const fresh = await createSpace('Fresh space');

    for (const [suffix, key] of [
      ['/tasks', 'tasks'],
      ['/materials', 'materials'],
      ['/drafts', 'drafts'],
      ['/history', 'entries'],
    ] as const) {
      const res = await app().inject({
        method: 'GET',
        url: `/api/workspaces/${fresh.id}${suffix}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()[key], `${suffix} leaked`).toEqual([]);
    }
  });

  it('refuses a cross-workspace write after both workspaces have been used', async () => {
    const first = await usedWorkspace('First space');
    const second = await usedWorkspace('Second space');

    // Attaching one workspace's material to the other's task is the write that
    // would quietly move bytes across the boundary.
    const link = await app().inject({
      method: 'POST',
      url: `/api/workspaces/${second.space.id}/tasks/${second.taskId}/material-links`,
      payload: { materialId: first.materialId },
    });
    expect(link.statusCode).toBe(404);

    const comment = await app().inject({
      method: 'POST',
      url: `/api/workspaces/${second.space.id}/tasks/${first.taskId}/discussion`,
      payload: { body: 'wrong workspace', guestLabel: 'Guest', clientRequestId: randomUUID() },
    });
    expect(comment.statusCode).toBe(404);
  });
});

// --- 2. owner-key isolation -------------------------------------------------

describe('owner keys stay bound to their own workspace', { timeout: 90_000 }, () => {
  it('will not apply one workspace review with another workspace key', async () => {
    // Stops before applying: §2.4 makes a completed task read-only, and
    // `prepare` correctly refuses a second review on one — so the key check
    // has to happen against the review that is actually appliable.
    const used = await usedWorkspace('Key space', false);
    const other = await createSpace('Other key space');
    const second = used.review;

    for (const [label, key] of [
      ['another workspace key', other.ownerKey],
      ['a forged key', 'not-the-owner-key-at-all-000000'],
    ] as const) {
      const res = await app().inject({
        method: 'POST',
        url: `/api/workspaces/${used.space.id}/reviews/${second.review.id}/apply`,
        payload: { candidateSha: second.candidateSha },
        headers: { 'x-owner-key': key },
      });
      // Section 12.2: a wrong key and a missing key are the same answer, so
      // neither confirms that some other key would have worked.
      expect(res.statusCode, `${label} was accepted`).toBe(403);
    }

    const absent = await app().inject({
      method: 'POST',
      url: `/api/workspaces/${used.space.id}/reviews/${second.review.id}/apply`,
      payload: { candidateSha: second.candidateSha },
    });
    expect(absent.statusCode).toBe(403);
  });

  it('never reports another workspace as owned, and never echoes the key', async () => {
    const used = await usedWorkspace('Echo space');
    const other = await createSpace('Echo other');

    const foreign = await app().inject({
      method: 'GET',
      url: `/api/workspaces/${other.id}`,
      headers: { 'x-owner-key': used.space.ownerKey },
    });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().isOwner).toBe(false);

    const own = await app().inject({
      method: 'GET',
      url: `/api/workspaces/${used.space.id}`,
      headers: { 'x-owner-key': used.space.ownerKey },
    });
    expect(own.json().isOwner).toBe(true);
    // The key is write-only: section 1.2 says no endpoint reads it back, and a
    // workspace read is the one most likely to drift into returning it.
    expect(own.body).not.toContain(used.space.ownerKey);
  });

  it('ignores ownership claimed in a request body', async () => {
    const used = await usedWorkspace('Claim space');

    const res = await app().inject({
      method: 'PATCH',
      url: `/api/workspaces/${used.space.id}`,
      payload: { name: 'Renamed by a contributor', isOwner: true },
    });
    // Section 12.2: an isOwner flag in a body is not a credential. Without the
    // header this is a contributor, whatever the body says.
    expect(res.statusCode).toBe(403);
  });
});

// --- 3. material reuse ------------------------------------------------------

describe('identical material bytes stay one object', { timeout: 90_000 }, () => {
  it('reuses the material across workspace and task uploads, and after a review', async () => {
    const used = await usedWorkspace('Reuse space');
    const bytes = 'the brief\n';

    // The same bytes the flow already uploaded, offered again unattached.
    const again = await uploadMaterial(used.space, bytes);
    expect(again.statusCode).toBe(200); // 200, not 201: reused
    expect(again.json().material.id).toBe(used.materialId);

    // And again attached to the task, after a review has been applied.
    const third = await uploadMaterial(used.space, bytes, { taskId: used.taskId });
    expect(third.statusCode).toBe(200);
    expect(third.json().material.id).toBe(used.materialId);

    const listed = await app().inject({
      method: 'GET',
      url: `/api/workspaces/${used.space.id}/materials`,
    });
    // Section 3.2: reattaching reuses the ID and the bytes. Three uploads of
    // one file is one material, or the Files view grows a duplicate per attach.
    expect(listed.json().materials).toHaveLength(1);
  });

  it('does not reuse across workspaces, even for identical bytes', async () => {
    const first = await usedWorkspace('Bytes A');
    const second = await createSpace('Bytes B');

    const copy = await uploadMaterial(second, 'the brief\n');
    expect(copy.statusCode).toBe(201);
    // Deduplication is a storage optimisation inside a workspace, never a
    // reason for two workspaces to share an object.
    expect(copy.json().material.id).not.toBe(first.materialId);
  });
});

// --- 4. version guards ------------------------------------------------------

describe('version guards hold once a task has history', () => {
  it('refuses a stale revision and reports the version to rebase onto', async () => {
    const space = await createSpace('Version space');
    const task = await postTask(space, 'Write the guide');

    const first = await app().inject({
      method: 'PATCH',
      url: `/api/workspaces/${space.id}/tasks/${task.id}`,
      payload: { expectedVersion: task.version, title: 'Renamed once' },
    });
    expect(first.statusCode).toBe(200);

    const stale = await app().inject({
      method: 'PATCH',
      url: `/api/workspaces/${space.id}/tasks/${task.id}`,
      payload: { expectedVersion: task.version, title: 'Renamed twice' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('TASK_VERSION_CHANGED');
    // Section 2.1: the point of the check is that the loser can rebase rather
    // than guess, which needs the current version in the response.
    expect(stale.json().error.details.currentVersion).toBe(first.json().version);
  });

  it('refuses a start carrying a version the task has moved past', async () => {
    const space = await createSpace('Start guard space');
    const task = await postTask(space, 'Start me');
    await app().inject({
      method: 'PATCH',
      url: `/api/workspaces/${space.id}/tasks/${task.id}`,
      payload: { expectedVersion: task.version, title: 'Changed before start' },
    });

    const res = await app().inject({
      method: 'POST',
      url: `/api/workspaces/${space.id}/tasks/${task.id}/start`,
      payload: { expectedVersion: task.version, clientRequestId: randomUUID() },
    });
    // Section 2.2 step 1 checks the submitted version, so a Start queued behind
    // an edit cannot run against requirements nobody approved.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TASK_VERSION_CHANGED');
  });

  it('produces one run from a replayed start and refuses a second attempt', async () => {
    const space = await createSpace('Duplicate start space');
    const task = await postTask(space, 'Only once');
    const clientRequestId = randomUUID();
    const start = () =>
      app().inject({
        method: 'POST',
        url: `/api/workspaces/${space.id}/tasks/${task.id}/start`,
        payload: { expectedVersion: task.version, clientRequestId },
      });

    const first = await start();
    expect(first.statusCode).toBe(202);
    const replay = await start();
    // Section 2.2: a replayed request resolves to the original run rather than
    // creating a second.
    expect(replay.statusCode).toBe(202);
    expect(replay.json().runId).toBe(first.json().runId);
    expect(replay.json().idempotentReplay).toBe(true);

    // A genuinely different intent is refused by the active-run rule instead.
    const rival = await app().inject({
      method: 'POST',
      url: `/api/workspaces/${space.id}/tasks/${task.id}/start`,
      payload: { expectedVersion: task.version, clientRequestId: randomUUID() },
    });
    expect(rival.statusCode).toBe(409);
    expect(rival.json().error.code).toBe('TASK_ALREADY_RUNNING');
  });
});

// --- 5. discussion persistence ----------------------------------------------

describe('discussion survives refresh and keeps its order', { timeout: 90_000 }, () => {
  it('reads back identically from a cold cursor and from a partial one', async () => {
    const used = await usedWorkspace('Thread space');
    await comment(used.space, used.taskId, 'Second thought.');
    await comment(used.space, used.taskId, 'Third thought.');

    const url = (afterSeq: number) =>
      `/api/workspaces/${used.space.id}/tasks/${used.taskId}/discussion?afterSeq=${afterSeq}`;
    const cold = (await app().inject({ method: 'GET', url: url(0) })).json();
    expect(cold.entries).toHaveLength(3);
    expect(cold.latestSeq).toBe(3);

    // Sequence is gap-free and equals commit order — that is what makes a run's
    // cutoff exact (section 2.3), so it has to survive a used workspace.
    expect(cold.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);

    // A browser that already holds the first entry asks for the rest, and gets
    // exactly the rest: refetching is additive, never a redisplay.
    const partial = (await app().inject({ method: 'GET', url: url(1) })).json();
    expect(partial.entries.map((e: { id: string }) => e.id)).toEqual(
      cold.entries.slice(1).map((e: { id: string }) => e.id),
    );
    expect(partial.latestSeq).toBe(3);
  });

  it('labels entries a running attempt will never read', async () => {
    const space = await createSpace('Cutoff space');
    const task = await postTask(space, 'Cutoff task');
    await comment(space, task.id, 'Before the run.');

    const started = await app().inject({
      method: 'POST',
      url: `/api/workspaces/${space.id}/tasks/${task.id}/start`,
      payload: { expectedVersion: task.version, clientRequestId: randomUUID() },
    });
    expect(started.statusCode).toBe(202);
    await comment(space, task.id, 'After the run started.');

    const page = (
      await app().inject({
        method: 'GET',
        url: `/api/workspaces/${space.id}/tasks/${task.id}/discussion`,
      })
    ).json();

    // Section 2.3 freezes a run's inputs at Start. Without this flag a
    // contributor cannot tell that what they just wrote reaches no agent.
    expect(page.activeRunCutoffSeq).toBe(1);
    expect(page.entries[0].afterActiveRunCutoff).toBe(false);
    expect(page.entries[1].afterActiveRunCutoff).toBe(true);
  });

  it('keeps the thread when the task is revised underneath it', async () => {
    const space = await createSpace('Revise thread space');
    const task = await postTask(space, 'Revised task');
    const entry = await comment(space, task.id, 'Said before the revision.');

    await app().inject({
      method: 'PATCH',
      url: `/api/workspaces/${space.id}/tasks/${task.id}`,
      payload: { expectedVersion: task.version, criteria: ['A new criterion'] },
    });

    const page = (
      await app().inject({
        method: 'GET',
        url: `/api/workspaces/${space.id}/tasks/${task.id}/discussion`,
      })
    ).json();
    // A version bump changes what the task asks for, not what people said
    // about it.
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].id).toBe(entry.id);
    expect(page.entries[0].body).toBe('Said before the revision.');
  });
});
