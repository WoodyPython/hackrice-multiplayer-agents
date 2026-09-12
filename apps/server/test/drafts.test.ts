import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PgDraftStore } from '../src/drafts/store.js';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';

/**
 * B05 acceptance (design sections 7.1 to 7.3, 7.6, 7.7, 11.3).
 *
 * Tests drive real Yjs documents rather than opaque byte blobs. Section 11.3 is
 * explicit that "plain text alone cannot reconstruct the full collaborative
 * operation history", so the thing worth proving is that what comes back out of
 * Postgres still merges correctly with concurrent edits.
 */

let t: TestApp;
let store: PgDraftStore;
let workspaceId: string;

beforeAll(async () => {
  t = await buildTestApp();
  store = new PgDraftStore({ db: t.handle.db });
  workspaceId = (await createWorkspaceViaApi(t.app, { name: 'Drafts' })).workspaceId;
});

afterAll(async () => {
  await t?.close();
});

// --- helpers ---------------------------------------------------------------

async function makeTask(title = 'Editing task'): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/tasks`,
    payload: { title, creatorGuestLabel: 'Guest Cedar' },
  });
  return res.json().id;
}

/** A Y.Doc with `text` in its shared text type, plus its encoded state. */
function docWith(text: string): { doc: Y.Doc; state: Uint8Array; vector: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return {
    doc,
    state: Y.encodeStateAsUpdate(doc),
    vector: Y.encodeStateVector(doc),
  };
}

function readText(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText('content').toString();
}

// ---------------------------------------------------------------------------

describe('opening a document', () => {
  it('creates one active document per task and path', async () => {
    const taskId = await makeTask();
    const first = await store.openForTask(workspaceId, taskId, 'documents/faq.md');
    const second = await store.openForTask(workspaceId, taskId, 'documents/faq.md');

    expect(second.id).toBe(first.id);
    expect(first.epoch).toBe(1);
    expect(first.persistedRevision).toBe(0);
    expect(first.status).toBe('active');
  });

  it('converges on one document when opened concurrently', async () => {
    /*
     * Repeated, not a single round. This race was previously broken in every
     * run and still passed a one-round test roughly a third of the time,
     * because whether two inserts genuinely overlap is a timing accident.
     * Twelve rounds makes a regression fail reliably rather than occasionally.
     */
    const taskId = await makeTask();
    for (let round = 0; round < 12; round += 1) {
      const path = `documents/race-${round}.md`;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.openForTask(workspaceId, taskId, path)),
      );
      expect(new Set(results.map((d) => d.id)).size, `round ${round} forked`).toBe(1);

      const rows = await t.handle.db
        .selectFrom('draft_files')
        .select('id')
        .where('task_id', '=', taskId)
        .where('path', '=', path)
        .execute();
      expect(rows, `round ${round} wrote extra rows`).toHaveLength(1);
    }
  }, 60_000);

  it('opens the next epoch after the previous one was closed', async () => {
    /*
     * Section 7.6: "Further editing creates a new task/draft epoch."
     *
     * Regression. Creation used to default to epoch 1, which works exactly
     * once: after Apply closes an epoch, inserting epoch 1 again collides with
     * the closed row, and the active-document lookup cannot see that row to
     * recover. Reopening any document after Apply failed outright.
     */
    const taskId = await makeTask();
    const first = await store.openForTask(workspaceId, taskId, 'documents/cycle.md');
    expect(first.epoch).toBe(1);

    await store.closeEpoch(workspaceId, taskId);
    const second = await store.openForTask(workspaceId, taskId, 'documents/cycle.md');
    expect(second.epoch).toBe(2);
    expect(second.id).not.toBe(first.id);

    // And it keeps working across further cycles.
    await store.closeEpoch(workspaceId, taskId);
    const third = await store.openForTask(workspaceId, taskId, 'documents/cycle.md');
    expect(third.epoch).toBe(3);
  });

  it('converges on one epoch when reopened concurrently after a close', async () => {
    // The two failure modes combined: several callers racing to compute the
    // same next epoch against a closed predecessor.
    const taskId = await makeTask();
    await store.openForTask(workspaceId, taskId, 'documents/recycle.md');
    await store.closeEpoch(workspaceId, taskId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.openForTask(workspaceId, taskId, 'documents/recycle.md'),
      ),
    );
    expect(new Set(results.map((d) => d.id)).size).toBe(1);
    expect(results[0]!.epoch).toBe(2);
  });

  it('keeps separate documents for separate paths', async () => {
    const taskId = await makeTask();
    const a = await store.openForTask(workspaceId, taskId, 'documents/a.md');
    const b = await store.openForTask(workspaceId, taskId, 'documents/b.md');
    expect(a.id).not.toBe(b.id);
  });
});

describe('listing active documents', () => {
  /**
   * The Files view (section 4.1) has to answer "what is being edited anywhere",
   * which the per-task listing cannot: it needs the owning task ID in order to
   * ask. Both listings exclude closed epochs, because offering a closed
   * document produces DOCUMENT_EPOCH_CLOSED the moment anyone opens it.
   */
  it('returns every active document in the workspace, across tasks', async () => {
    const first = await makeTask();
    const second = await makeTask();
    await store.openForTask(workspaceId, first, 'documents/a.md');
    await store.openForTask(workspaceId, second, 'documents/b.md');

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/drafts`,
    });

    expect(res.statusCode).toBe(200);
    const paths = res.json().drafts.map((draft: { path: string }) => draft.path);
    expect(paths).toContain('documents/a.md');
    expect(paths).toContain('documents/b.md');
    // The per-task listing sees only its own, which is why the workspace one
    // had to exist rather than the view calling that per task it does not know.
    const scoped = await store.listActiveForTask(workspaceId, first);
    expect(scoped.map((draft) => draft.path)).toEqual(['documents/a.md']);
  });

  it('omits a closed epoch', async () => {
    const taskId = await makeTask();
    await store.openForTask(workspaceId, taskId, 'documents/closing.md');
    await store.closeEpoch(workspaceId, taskId);

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/drafts`,
    });
    const paths = res.json().drafts.map((draft: { path: string }) => draft.path);
    expect(paths).not.toContain('documents/closing.md');
  });

  it('does not leak documents from another workspace', async () => {
    const taskId = await makeTask();
    await store.openForTask(workspaceId, taskId, 'documents/private.md');

    const other = (await createWorkspaceViaApi(t.app, { name: 'Elsewhere' }))
      .workspaceId;
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${other}/drafts`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().drafts).toEqual([]);
  });
});

describe('Edit together', () => {
  it('creates a manual-edit task and its document', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/drafts/open`,
      payload: { path: 'documents/guide.md', guestLabel: 'Guest Cedar' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.draftFile.path).toBe('documents/guide.md');

    const task = await t.handle.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', body.taskId)
      .executeTakeFirstOrThrow();
    expect(task.kind).toBe('manual_edit');
    expect(task.manual_source_path).toBe('documents/guide.md');
  });

  it('reuses the existing editing session for the same file', async () => {
    const open = async () =>
      t.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/drafts/open`,
        payload: { path: 'documents/shared.md', guestLabel: 'Guest Fern' },
      });

    const first = await open();
    const second = await open();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().taskId).toBe(first.json().taskId);
    expect(second.json().draftFile.id).toBe(first.json().draftFile.id);
  });

  it('converges when several people click at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspaceId}/drafts/open`,
          payload: { path: 'documents/stampede.md', guestLabel: 'Guest Ash' },
        }),
      ),
    );

    // Assert success first. Folding an error response into the Set below would
    // show up as a second distinct id and read like a convergence failure,
    // hiding whatever actually went wrong.
    for (const r of results) {
      expect(r.statusCode, `open failed: ${r.body}`).toBeLessThan(300);
    }
    expect(new Set(results.map((r) => r.json().taskId)).size).toBe(1);
    expect(new Set(results.map((r) => r.json().draftFile.id)).size).toBe(1);
  });

  it('rejects a path that escapes the repository', async () => {
    for (const path of ['../../etc/passwd', '/etc/passwd', '.git/config']) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/drafts/open`,
        payload: { path, guestLabel: 'Guest Cedar' },
      });
      expect(res.statusCode, `path ${path} was accepted`).toBe(400);
    }
  });
});

describe('initialize once', () => {
  it('seeds the document and reports that it did', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/seed.md');
    const { state, vector } = docWith('# Seeded from Git\n');

    const result = await store.initialize(draft.id, {
      yjsState: state,
      stateVector: vector,
      baseBlobSha: 'a'.repeat(40),
    });

    expect(result.initialized).toBe(true);
    expect(result.draft.draftFile.baseBlobSha).toBe('a'.repeat(40));
    expect(readText(result.draft.yjsState!)).toBe('# Seeded from Git\n');
  });

  it('refuses a second seed and hands back what the winner stored', async () => {
    /*
     * Section 7.2: "Never seed the same text independently in each browser;
     * merging separately initialized copies can duplicate content." Without
     * this guard the second caller's document would be merged in and the text
     * would appear twice.
     */
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/once.md');

    const first = docWith('original text');
    await store.initialize(draft.id, {
      yjsState: first.state,
      stateVector: first.vector,
      baseBlobSha: null,
    });

    const second = docWith('different text');
    const result = await store.initialize(draft.id, {
      yjsState: second.state,
      stateVector: second.vector,
      baseBlobSha: null,
    });

    expect(result.initialized).toBe(false);
    expect(readText(result.draft.yjsState!)).toBe('original text');
  });

  it('lets exactly one of several concurrent seeds win', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/concurrent.md');

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        const { state, vector } = docWith(`seed ${i}`);
        return store.initialize(draft.id, {
          yjsState: state,
          stateVector: vector,
          baseBlobSha: null,
        });
      }),
    );

    expect(results.filter((r) => r.initialized)).toHaveLength(1);
    // Everyone ends up looking at the same document.
    const texts = new Set(results.map((r) => readText(r.draft.yjsState!)));
    expect(texts.size).toBe(1);
  });
});

describe('revision-guarded persistence', () => {
  it('round-trips a document through Postgres intact', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/roundtrip.md');
    const { doc, state, vector } = docWith('Hello');
    await store.initialize(draft.id, { yjsState: state, stateVector: vector, baseBlobSha: null });

    doc.getText('content').insert(5, ', world');
    await store.persist(draft.id, {
      revision: 1,
      yjsState: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
    });

    const loaded = await store.load(workspaceId, draft.id);
    expect(readText(loaded!.yjsState!)).toBe('Hello, world');
    expect(loaded!.draftFile.persistedRevision).toBe(1);
  });

  it('preserves enough history to merge a concurrent edit', async () => {
    /*
     * The reason section 11.3 stores the full binary state rather than the
     * text: a client that was offline must still be able to merge. If we stored
     * plain text and re-seeded, this concurrent insert would be lost or
     * duplicated.
     */
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/merge.md');

    const alice = new Y.Doc();
    alice.getText('content').insert(0, 'shared base. ');
    await store.initialize(draft.id, {
      yjsState: Y.encodeStateAsUpdate(alice),
      stateVector: Y.encodeStateVector(alice),
      baseBlobSha: null,
    });

    // Bob forks from the persisted state and edits offline.
    const persisted = (await store.load(workspaceId, draft.id))!.yjsState!;
    const bob = new Y.Doc();
    Y.applyUpdate(bob, persisted);
    bob.getText('content').insert(bob.getText('content').length, 'bob was here. ');

    // Alice edits meanwhile and saves.
    alice.getText('content').insert(alice.getText('content').length, 'alice too. ');
    await store.persist(draft.id, {
      revision: 1,
      yjsState: Y.encodeStateAsUpdate(alice),
      stateVector: Y.encodeStateVector(alice),
    });

    // Bob reconnects: merging both directions converges on one text with both
    // edits present exactly once.
    const reloaded = (await store.load(workspaceId, draft.id))!.yjsState!;
    Y.applyUpdate(bob, reloaded);
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));

    const merged = bob.getText('content').toString();
    expect(merged).toBe(alice.getText('content').toString());
    expect(merged).toContain('bob was here.');
    expect(merged).toContain('alice too.');
    expect(merged.match(/bob was here/g)).toHaveLength(1);
  });

  it('refuses a save older than what is already stored', async () => {
    // Section 11.3: an asynchronous write completing late must not clobber a
    // newer snapshot.
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/stale.md');

    const newer = docWith('revision five');
    await store.persist(draft.id, {
      revision: 5,
      yjsState: newer.state,
      stateVector: newer.vector,
    });

    const older = docWith('revision two, arriving late');
    const result = await store.persist(draft.id, {
      revision: 2,
      yjsState: older.state,
      stateVector: older.vector,
    });

    expect(result.applied).toBe(false);
    expect(result.persistedRevision).toBe(5);

    const loaded = await store.load(workspaceId, draft.id);
    expect(readText(loaded!.yjsState!)).toBe('revision five');
  });

  it('refuses a save at the same revision', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/same.md');
    const first = docWith('first at revision three');
    await store.persist(draft.id, {
      revision: 3,
      yjsState: first.state,
      stateVector: first.vector,
    });

    const second = docWith('second at revision three');
    const result = await store.persist(draft.id, {
      revision: 3,
      yjsState: second.state,
      stateVector: second.vector,
    });
    expect(result.applied).toBe(false);
    expect(readText((await store.load(workspaceId, draft.id))!.yjsState!)).toBe(
      'first at revision three',
    );
  });

  it('keeps the highest revision under concurrent out-of-order saves', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/ooo.md');

    // Fire revisions 1..8 all at once, in shuffled order.
    const order = [4, 1, 7, 3, 8, 2, 6, 5];
    await Promise.all(
      order.map((revision) => {
        const { state, vector } = docWith(`revision ${revision}`);
        return store.persist(draft.id, { revision, yjsState: state, stateVector: vector });
      }),
    );

    const loaded = await store.load(workspaceId, draft.id);
    expect(loaded!.draftFile.persistedRevision).toBe(8);
    expect(readText(loaded!.yjsState!)).toBe('revision 8');
  });

  it('stores the state vector alongside the state', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/vector.md');
    const { doc, state, vector } = docWith('vectored');
    await store.persist(draft.id, { revision: 1, yjsState: state, stateVector: vector });

    const loaded = await store.load(workspaceId, draft.id);
    expect(Buffer.from(loaded!.stateVector!)).toEqual(Buffer.from(vector));
    // The vector is what lets a peer compute a minimal diff.
    const diff = Y.encodeStateAsUpdate(doc, loaded!.stateVector!);
    expect(diff.byteLength).toBeLessThan(state.byteLength);
  });
});

describe('closed epochs', () => {
  it('rejects writes after the epoch is closed', async () => {
    // Section 7.7: "reject old-epoch writes".
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/closed.md');
    const { state, vector } = docWith('before apply');
    await store.persist(draft.id, { revision: 1, yjsState: state, stateVector: vector });

    const closed = await store.closeEpoch(workspaceId, taskId);
    expect(closed).toBe(1);

    const later = docWith('after apply');
    await expect(
      store.persist(draft.id, {
        revision: 2,
        yjsState: later.state,
        stateVector: later.vector,
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_EPOCH_CLOSED' });
  });

  it('refuses to resolve a closed room', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/room.md');
    await store.closeEpoch(workspaceId, taskId);

    await expect(
      store.resolveRoom({ workspaceId, taskId, draftFileId: draft.id }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_EPOCH_CLOSED' });
  });

  it('keeps the closed document as history when a new epoch opens', async () => {
    /*
     * Section 7.6: do not reuse an old epoch for new approved content. The old
     * row must survive so a browser holding unsent edits against it can be told
     * what happened rather than having its document silently redefined.
     */
    const taskId = await makeTask();
    const first = await store.openForTask(workspaceId, taskId, 'documents/epoch.md');
    const { state, vector } = docWith('epoch one content');
    await store.initialize(first.id, {
      yjsState: state,
      stateVector: vector,
      baseBlobSha: null,
    });
    await store.closeEpoch(workspaceId, taskId);

    const second = await store.openNextEpoch(workspaceId, taskId, 'documents/epoch.md');
    expect(second.id).not.toBe(first.id);
    expect(second.epoch).toBe(2);
    expect(second.persistedRevision).toBe(0);

    // The old one is still readable.
    const old = await store.load(workspaceId, first.id);
    expect(old!.draftFile.status).toBe('closed');
    expect(readText(old!.yjsState!)).toBe('epoch one content');
  });

  it('is idempotent when the epoch is already closed', async () => {
    const taskId = await makeTask();
    await store.openForTask(workspaceId, taskId, 'documents/twice.md');
    expect(await store.closeEpoch(workspaceId, taskId)).toBe(1);
    expect(await store.closeEpoch(workspaceId, taskId)).toBe(0);
  });
});

describe('room resolution', () => {
  it('refuses a document from another task', async () => {
    const taskA = await makeTask('A');
    const taskB = await makeTask('B');
    const draft = await store.openForTask(workspaceId, taskA, 'documents/scoped.md');

    await expect(
      store.resolveRoom({ workspaceId, taskId: taskB, draftFileId: draft.id }),
    ).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  it('refuses a document from another workspace', async () => {
    const other = (await createWorkspaceViaApi(t.app, { name: 'Other' })).workspaceId;
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/ws.md');

    await expect(
      store.resolveRoom({ workspaceId: other, taskId, draftFileId: draft.id }),
    ).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  it('resolves a live document', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/live.md');
    const resolved = await store.resolveRoom({ workspaceId, taskId, draftFileId: draft.id });
    expect(resolved.id).toBe(draft.id);
  });
});

describe('there is no HTTP route that writes a snapshot', () => {
  it('exposes no persist endpoint', async () => {
    /*
     * Section 11.4: browsers do not mutate storage directly. A route accepting
     * a Yjs snapshot would let any link holder replace a document wholesale,
     * bypassing every update the room server validated.
     */
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/noroute.md');

    for (const url of [
      `/api/workspaces/${workspaceId}/drafts/${draft.id}/persist`,
      `/api/workspaces/${workspaceId}/drafts/${draft.id}`,
      `/api/workspaces/${workspaceId}/tasks/${taskId}/drafts/${draft.id}`,
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        payload: { revision: 99, yjsStateBase64: 'AAA=', stateVectorBase64: 'AAA=' },
      });
      expect(res.statusCode, `${url} is reachable`).toBe(404);
    }
  });

  it('lists the drafts of a task without exposing their bytes', async () => {
    const taskId = await makeTask();
    const draft = await store.openForTask(workspaceId, taskId, 'documents/listed.md');
    const { state, vector } = docWith('secret-ish content');
    await store.initialize(draft.id, {
      yjsState: state,
      stateVector: vector,
      baseBlobSha: null,
    });

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/drafts`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().drafts).toHaveLength(1);
    expect(res.body).not.toContain('yjsState');
    expect(res.body).not.toContain('yjs_state');
  });
});
