import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventKeys, workspaceChannel } from '@app/contracts';
import { RecordingBroadcaster } from '../src/events/broadcaster.js';
import { TaskEventPump } from '../src/events/pump.js';
import { TaskEventService, appendEvent } from '../src/events/service.js';
import { buildTestApp, createWorkspaceViaApi, type TestApp } from './app-helpers.js';

/**
 * B06 acceptance (design sections 5.1, 11.5).
 *
 * The properties that matter: an event is durable before any hint mentions it,
 * a hint carries nothing a forged message could act on, and repeated or missed
 * hints change nothing.
 */

let t: TestApp;
let broadcaster: RecordingBroadcaster;
let events: TaskEventService;
let workspaceId: string;

beforeAll(async () => {
  t = await buildTestApp();
  broadcaster = new RecordingBroadcaster();
  events = new TaskEventService({ db: t.handle.db, broadcaster });
  workspaceId = (await createWorkspaceViaApi(t.app, { name: 'Events' })).workspaceId;
});

afterAll(async () => {
  await t?.close();
});

async function makeTask(title = 'Event task'): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/tasks`,
    payload: { title, creatorGuestLabel: 'Guest Cedar' },
  });
  return res.json().id;
}

// ---------------------------------------------------------------------------

describe('durable events', () => {
  it('records what posting a task did', async () => {
    const taskId = await makeTask();
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/events`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().events.map((e: { type: string }) => e.type)).toEqual(['task.posted']);
  });

  it('accumulates a run lifecycle in order', async () => {
    const taskId = await makeTask();
    await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/start`,
      payload: { expectedVersion: 1, clientRequestId: randomUUID() },
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      payload: {},
    });

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/events`,
    });
    expect(res.json().events.map((e: { type: string }) => e.type)).toEqual([
      'task.posted',
      'task.started',
      'task.canceled',
    ]);
  });

  it('is idempotent on the event key, so a retried append adds nothing', async () => {
    // Section 11.5: "Use deterministic event keys where an operation may
    // repeat."
    const taskId = await makeTask();
    const input = {
      workspaceId,
      taskId,
      eventKey: eventKeys.taskPosted(taskId),
      type: 'task.posted' as const,
    };

    const again = await events.append(input);
    expect(again.created).toBe(false);

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/events`,
    });
    expect(res.json().events).toHaveLength(1);
  });

  it('reads forward from a cursor so a reconnect does not re-read everything', async () => {
    const taskId = await makeTask();
    for (let i = 0; i < 4; i += 1) {
      await events.append({
        workspaceId,
        taskId,
        eventKey: `probe:${i}`,
        type: 'agent.started',
      });
    }

    const all = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/events`,
    });
    expect(all.json().events).toHaveLength(5);

    const cursor = all.json().events[2].id;
    const rest = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/tasks/${taskId}/events?afterId=${cursor}`,
    });
    expect(rest.json().events).toHaveLength(2);
    expect(rest.json().latestId).toBe(all.json().latestId);
  });

  it('scopes events to their workspace', async () => {
    const other = (await createWorkspaceViaApi(t.app, { name: 'Other' })).workspaceId;
    const taskId = await makeTask();
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${other}/tasks/${taskId}/events`,
    });
    expect(res.json().events).toEqual([]);
  });
});

describe('an event is durable before any hint mentions it', () => {
  it('broadcasts nothing for a transaction that rolled back', async () => {
    /*
     * Section 11.5: "Persist task events before broadcasting their IDs."
     *
     * This is why hints are swept out of the table rather than sent at each
     * append site. A rolled-back transaction leaves no row, so there is nothing
     * to sweep — the ordering holds by construction rather than by every caller
     * remembering to place its broadcast after commit.
     */
    const taskId = await makeTask();
    const pump = new TaskEventPump({ db: t.handle.db, broadcaster });
    await pump.start();

    await expect(
      t.handle.db.transaction().execute(async (trx) => {
        await appendEvent(trx, {
          workspaceId,
          taskId,
          eventKey: `rolled-back:${randomUUID()}`,
          type: 'agent.started',
        });
        throw new Error('the operation failed after recording its event');
      }),
    ).rejects.toThrow();

    const before = broadcaster.sent.length;
    await pump.flush();
    expect(broadcaster.sent.length).toBe(before);
    await pump.stop();
  });

  it('broadcasts an event that did commit', async () => {
    const taskId = await makeTask();
    const pump = new TaskEventPump({ db: t.handle.db, broadcaster });
    await pump.start();

    const appended = await events.append({
      workspaceId,
      taskId,
      eventKey: `committed:${randomUUID()}`,
      type: 'agent.completed',
    });

    const before = broadcaster.sent.length;
    await pump.flush();
    const sent = broadcaster.sent.slice(before);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      workspaceId,
      taskId,
      eventType: 'agent.completed',
      eventId: appended.eventId,
    });
    await pump.stop();
  });
});

describe('the pump', () => {
  it('does not replay history on start', async () => {
    // Section 11.5 makes missed hints harmless, and replaying every event in a
    // workspace on boot would be a thundering herd of refetches.
    const taskId = await makeTask();
    await events.append({
      workspaceId,
      taskId,
      eventKey: `historic:${randomUUID()}`,
      type: 'task.posted',
    });

    const fresh = new RecordingBroadcaster();
    const pump = new TaskEventPump({ db: t.handle.db, broadcaster: fresh });
    await pump.start();
    await pump.flush();

    expect(fresh.sent).toEqual([]);
    await pump.stop();
  });

  it('advances its watermark so a second sweep resends nothing', async () => {
    const taskId = await makeTask();
    const fresh = new RecordingBroadcaster();
    const pump = new TaskEventPump({ db: t.handle.db, broadcaster: fresh });
    await pump.start();

    try {
      await events.append({
        workspaceId,
        taskId,
        eventKey: `once:${randomUUID()}`,
        type: 'agent.waiting',
      });

      expect(await pump.flush()).toBe(1);
      expect(await pump.flush()).toBe(0);
      expect(fresh.sent).toHaveLength(1);
    } finally {
      // Every started pump must be stopped, including on a failing assertion.
      // A leaked sweep keeps querying the shared test database for the rest of
      // the run, which is exactly the kind of cross-file interference that
      // makes an unrelated suite fail intermittently.
      await pump.stop();
    }
  });

  it('keeps sweeping after a broadcaster failure', async () => {
    // `hint` is contractually non-throwing, but a transport that breaks the
    // contract must not stall the pump permanently.
    const taskId = await makeTask();
    let calls = 0;
    const flaky = {
      sent: [] as unknown[],
      async hint(input: unknown) {
        calls += 1;
        if (calls === 1) throw new Error('transport down');
        this.sent.push(input);
      },
    };

    const pump = new TaskEventPump({ db: t.handle.db, broadcaster: flaky });
    await pump.start();

    await events.append({
      workspaceId, taskId, eventKey: `flaky-a:${randomUUID()}`, type: 'agent.started',
    });
    await pump.flush();

    await events.append({
      workspaceId, taskId, eventKey: `flaky-b:${randomUUID()}`, type: 'agent.completed',
    });
    await pump.flush();

    expect(flaky.sent.length).toBeGreaterThan(0);
    await pump.stop();
  });
});

describe('a hint carries no authority', () => {
  it('contains only what is needed to decide what to refetch', async () => {
    /*
     * Section 5.1: "Assume channel messages can be forged by a link holder;
     * carry only refresh hints, not executable commands or approval decisions."
     */
    const taskId = await makeTask();
    const fresh = new RecordingBroadcaster();
    const pump = new TaskEventPump({ db: t.handle.db, broadcaster: fresh });
    await pump.start();

    await events.append({
      workspaceId,
      taskId,
      eventKey: `payload:${randomUUID()}`,
      type: 'review.ready',
      // Even when the durable event carries detail, the hint must not.
      payload: { candidateSha: 'a'.repeat(40), secretish: 'do not broadcast me' },
    });
    await pump.flush();

    const hint = fresh.sent.at(-1)!;
    expect(Object.keys(hint).sort()).toEqual([
      'eventId',
      'eventType',
      'taskId',
      'workspaceId',
    ]);
    expect(JSON.stringify(hint)).not.toContain('do not broadcast me');
    await pump.stop();
  });
});

describe('realtime configuration for the browser', () => {
  it('returns the workspace channel and nothing secret', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/realtime`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe(workspaceChannel(workspaceId));
    // Section 5.3: the browser gets public locations and the publishable key.
    expect(res.body).not.toContain('SERVICE_ROLE');
    expect(res.body).not.toContain('postgresql://');
    expect(res.body).not.toContain('GEMINI');
  });

  it('reports null when no project is configured, so clients poll', async () => {
    // Every local run. Section 5 already specifies polling as the fallback, and
    // durable events are authoritative either way.
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/realtime`,
    });
    expect(res.json().realtime).toBeNull();
  });

  it('reports the publishable key when one is configured', async () => {
    const configured = await buildTestApp({
      config: {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_must_not_leak',
      },
    });
    try {
      const ws = (await createWorkspaceViaApi(configured.app, { name: 'Configured' }))
        .workspaceId;
      const res = await configured.app.inject({
        method: 'GET',
        url: `/api/workspaces/${ws}/realtime`,
      });

      expect(res.json().realtime).toEqual({
        url: 'https://example.supabase.co',
        publishableKey: 'sb_publishable_example',
      });
      // The service-role key is never on the wire.
      expect(res.body).not.toContain('sb_secret_must_not_leak');
    } finally {
      await configured.close();
    }
  });
});
