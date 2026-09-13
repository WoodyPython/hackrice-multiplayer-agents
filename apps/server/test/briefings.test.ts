import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BRIEFING_SESSION_HEADER, NullOrchestrationHook, NullWorkspaceLifecycleHook, briefingSchema } from '@app/contracts';
import { buildApp } from '../src/http/app.js';
import { BriefingService, hashBriefingSession } from '../src/briefings/service.js';
import { registerBriefingRoutes } from '../src/briefings/routes.js';
import { ModelAdapterError, type AgentRequest, type AgentResponse } from '../src/models/types.js';
import type { DbHandle } from '../src/db/client.js';
import { createWorkspaceViaApi, testConfig, authenticateRuntime } from './app-helpers.js';
import {
  connectTestDb, fakeSha, insertAgentInstance, insertBudget, insertDiscussionEntry, insertRun,
} from './helpers.js';

/**
 * "Catch me up" end to end through the HTTP surface, against a real database
 * and a scripted model. The model is the one thing faked: what reaches it, what
 * survives validation, and what is stored are all real.
 */

type Reply = (prompt: { activity: Array<{ ref: string; task: string | null }>; tasks: Array<{ ref: string; title: string }> }) => AgentResponse | Error;

class ScriptedAdapter {
  calls: AgentRequest[] = [];
  reply: Reply = () => new Error('no reply scripted');
  getModel() { return { modelId: 'fake', minOutputTokens: 1, maxOutputTokens: 65536 }; }
  async generate(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(structuredClone(request));
    const first = request.messages[0];
    const result = this.reply(JSON.parse(first?.role === 'user' ? first.text : '{}'));
    if (result instanceof Error) throw result;
    return result;
  }
}

const json = (value: unknown): AgentResponse => ({
  text: JSON.stringify(value), toolCalls: [], usage: { status: 'unknown' }, finishReason: 'STOP',
});

let handle: DbHandle;
let app: FastifyInstance;
const adapter = new ScriptedAdapter();

beforeAll(async () => {
  handle = connectTestDb();
  app = await buildApp({ db: handle.db, config: testConfig(), lifecycle: new NullWorkspaceLifecycleHook(), orchestration: new NullOrchestrationHook() });
  const briefings = new BriefingService({ db: handle.db, adapter, sources: { approvedPaths: async () => new Set(['docs/launch.md']) } });
  await registerBriefingRoutes(app, { briefings, rateLimit: { max: 1000, timeWindow: '1 minute' } });
  // Briefing routes are workspace routes, so membership is checked in front
  // of them like any other. This suite is about briefing behaviour, not the
  // gate -- permissions.test.ts covers who may generate one.
  await authenticateRuntime(app, handle.db);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

beforeEach(() => {
  adapter.calls = [];
  adapter.reply = () => new Error('no reply scripted');
});

const generate = (workspaceId: string, session: string, window = 'since_last') =>
  app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/briefings`, headers: { [BRIEFING_SESSION_HEADER]: session }, payload: { window } });
const history = (workspaceId: string, session: string) =>
  app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/briefings`, headers: { [BRIEFING_SESSION_HEADER]: session } });

async function seededWorkspace() {
  const { workspaceId } = await createWorkspaceViaApi(app, { name: 'Launch room' });
  const post = async (title: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks`, payload: { title, creatorGuestLabel: 'Guest Cedar' } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const launch = await post('Write the launch post');
  const faq = await post('Draft the FAQ');
  const comment = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${faq}/discussion`,
    payload: { body: 'Should the FAQ cover pricing?', guestLabel: 'Guest Maple' } });
  expect(comment.statusCode).toBe(201);
  return { workspaceId, launch, faq };
}

describe('briefing routes', () => {
  it('requires a session key, a known workspace, and a supported window', async () => {
    const { workspaceId } = await createWorkspaceViaApi(app);
    expect((await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/briefings`, payload: { window: 'since_last' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/briefings` })).statusCode).toBe(400);
    expect((await generate(workspaceId, randomUUID(), 'last_week')).json().error.code).toBe('VALIDATION_FAILED');
    // Authorization runs in front of the handler now, so a caller who is not a
    // member is refused before the server says whether the workspace exists.
    // Nobody can brief a workspace they are not in, so the old 404 unlocked
    // nothing; this only stops random UUIDs being probed for existence.
    const missing = await generate(randomUUID(), randomUUID());
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('FORBIDDEN');
  });

  it('reports an empty window without calling the model or moving the cutoff', async () => {
    const { workspaceId } = await createWorkspaceViaApi(app);
    const session = randomUUID();
    const res = await generate(workspaceId, session);
    expect(res.statusCode).toBe(200);
    const briefing = briefingSchema.parse(res.json());
    expect(briefing).toMatchObject({ source: 'empty', id: null, cutoffAdvanced: false, firstBriefing: true, changes: [], nextSteps: [] });
    expect(adapter.calls).toHaveLength(0);
    expect((await history(workspaceId, session)).json()).toEqual({ cutoff: null, briefings: [] });
  });

  it('generates a validated briefing, stores it for this session only, and advances the cutoff', async () => {
    const { workspaceId, launch, faq } = await seededWorkspace();
    const session = randomUUID();
    const eventsBefore = await handle.db.selectFrom('task_events').select('id').where('workspace_id', '=', workspaceId).execute();
    adapter.reply = (prompt) => {
      const faqTask = prompt.tasks.find((task) => task.title === 'Draft the FAQ')!.ref;
      const faqActivity = prompt.activity.filter((item) => item.task === faqTask).map((item) => item.ref);
      return json({
        changes: [
          { text: 'The FAQ task was posted and Guest Maple asked about pricing.', refs: faqActivity },
          { text: 'The launch post shipped to customers.', refs: ['T1'] },
          { text: 'An invented release happened.', refs: ['A404'] },
        ],
        nextSteps: [1, 2, 3, 4, 5].map((n) => ({ text: `Suggestion ${n} for the FAQ.`, refs: [faqTask] })),
      });
    };

    const res = await generate(workspaceId, session);
    expect(res.statusCode).toBe(200);
    const briefing = briefingSchema.parse(res.json());
    expect(briefing.source).toBe('gemini');
    expect(briefing.id).not.toBeNull();
    expect(briefing.cutoffAdvanced).toBe(true);
    expect(briefing.changes.map((item) => item.text)).toEqual(['The FAQ task was posted and Guest Maple asked about pricing.']);
    expect(briefing.changes[0]!.links).toContainEqual({ kind: 'task', taskId: faq, label: 'Draft the FAQ' });
    expect(briefing.nextSteps).toHaveLength(3);
    expect(briefing.stats).toMatchObject({ tasksTouched: 2, comments: 1 });
    expect(briefing.activity.map((item) => item.text)).toContain('“Write the launch post” was posted');
    expect(briefing.activity.flatMap((item) => item.links)).toContainEqual({ kind: 'task', taskId: launch, label: 'Write the launch post' });

    // What the model saw: records by key, no IDs.
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.preset).toBe('analyst');
    const sent = JSON.stringify(adapter.calls[0]);
    for (const id of [workspaceId, launch, faq]) expect(sent).not.toContain(id);

    // Read-only: generating a briefing wrote no task events.
    const eventsAfter = await handle.db.selectFrom('task_events').select('id').where('workspace_id', '=', workspaceId).execute();
    expect(eventsAfter).toHaveLength(eventsBefore.length);

    const mine = (await history(workspaceId, session)).json();
    expect(mine.cutoff).toBe(briefing.until);
    expect(mine.briefings.map((item: { id: string }) => item.id)).toEqual([briefing.id]);
    expect((await history(workspaceId, randomUUID())).json()).toEqual({ cutoff: null, briefings: [] });
    const elsewhere = await createWorkspaceViaApi(app);
    expect((await history(elsewhere.workspaceId, session)).json()).toEqual({ cutoff: null, briefings: [] });

    // Since last briefing now starts at that cutoff, and nothing has happened since.
    const next = briefingSchema.parse((await generate(workspaceId, session)).json());
    expect(next).toMatchObject({ source: 'empty', since: briefing.until, previousCutoff: briefing.until, firstBriefing: false });
  });

  it('falls back to the factual recap when Gemini fails, without moving the cutoff', async () => {
    const { workspaceId } = await seededWorkspace();
    const session = randomUUID();
    for (const [reply, reason] of [
      [() => new ModelAdapterError('provider_error', 'Gemini request failed.', true, 503), 'model_failed'],
      [() => new ModelAdapterError('configuration', 'GEMINI_API_KEY is required for agent execution.'), 'model_unavailable'],
      [() => json({ changes: [{ text: 'Everything shipped.', refs: [] }], nextSteps: [] }), 'invalid_output'],
      [() => ({ ...json({ changes: [], nextSteps: [] }), finishReason: 'MAX_TOKENS' }), 'invalid_output'],
    ] as const) {
      adapter.reply = reply;
      const res = await generate(workspaceId, session);
      expect(res.statusCode).toBe(200);
      const briefing = briefingSchema.parse(res.json());
      expect(briefing).toMatchObject({ source: 'fallback', fallbackReason: reason, id: null, cutoffAdvanced: false, nextSteps: [] });
      expect(briefing.changes.length).toBeGreaterThan(0);
      expect(briefing.changes.map((item) => item.text)).toEqual(briefing.activity.slice(0, briefing.changes.length).map((item) => item.text));
      expect(res.body).not.toContain('GEMINI_API_KEY');
    }
    expect((await history(workspaceId, session)).json()).toEqual({ cutoff: null, briefings: [] });
  });

  it('lists open questions and unresolved reviews from records, with links', async () => {
    const { workspaceId, launch, faq } = await seededWorkspace();
    const db = handle.db;
    const run = await insertRun(db, workspaceId, faq, { status: 'needs_input' });
    await insertBudget(db, workspaceId, faq, 'analyst');
    const agent = await insertAgentInstance(db, workspaceId, faq, run, { agent_key: 'analyst', assignment_key: 'analyst', preset: 'analyst' });
    const entry = await insertDiscussionEntry(db, workspaceId, faq, { seq: 50, actor_type: 'agent', body: 'Which regions does the FAQ cover?' });
    await db.insertInto('agent_questions').values({ workspace_id: workspaceId, task_id: faq, run_id: run,
      agent_instance_id: agent, question_entry_id: entry, expires_at: new Date(Date.now() + 600_000) }).execute();
    await db.updateTable('tasks').set({ status: 'ready_for_review' }).where('id', '=', launch).execute();
    const review = await db.insertInto('reviews').values({ workspace_id: workspaceId, task_id: launch, task_version: 1,
      guidance_version: 1, main_sha: fakeSha('m'), human_sha: fakeSha('h'), context_hash: 'ctx', candidate_sha: fakeSha('c'), status: 'ready' })
      .returning('id').executeTakeFirstOrThrow();

    adapter.reply = () => new ModelAdapterError('provider_error', 'Gemini request failed.');
    const briefing = briefingSchema.parse((await generate(workspaceId, randomUUID(), 'last_hour')).json());
    expect(briefing.stats).toMatchObject({ openQuestions: 1, unresolvedReviews: 1 });
    expect(briefing.needsAttention).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'question', text: expect.stringContaining('Which regions does the FAQ cover?'),
        links: [{ kind: 'task', taskId: faq, label: 'Draft the FAQ' }] }),
      expect.objectContaining({ kind: 'review', text: 'Changes for “Write the launch post” are ready to review',
        links: [{ kind: 'task', taskId: launch, label: 'Write the launch post' },
          { kind: 'review', taskId: launch, reviewId: review.id, label: 'Review of Write the launch post' }] }),
    ]));
    // The question entry is an attention item, not an ordinary comment.
    expect(briefing.stats.comments).toBe(1);
  });

  it('advances the cutoff for a fixed window only when it covers the gap', async () => {
    const { workspaceId } = await seededWorkspace();
    const session = randomUUID();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await handle.db.insertInto('workspace_briefings').values({ workspace_id: workspaceId, viewer_hash: hashBriefingSession(session),
      window_mode: 'since_last', window_start: new Date(threeHoursAgo.getTime() - 60_000), window_end: threeHoursAgo,
      advances_cutoff: true, content: {} }).execute();
    adapter.reply = (prompt) => json({ changes: [{ text: 'Two tasks were posted.', refs: prompt.activity.map((item) => item.ref) }], nextSteps: [] });

    const hour = briefingSchema.parse((await generate(workspaceId, session, 'last_hour')).json());
    expect(hour).toMatchObject({ source: 'gemini', cutoffAdvanced: false, previousCutoff: threeHoursAgo.toISOString() });
    expect((await history(workspaceId, session)).json().cutoff).toBe(threeHoursAgo.toISOString());

    const day = briefingSchema.parse((await generate(workspaceId, session, 'last_24h')).json());
    expect(day).toMatchObject({ source: 'gemini', cutoffAdvanced: true });
    const listed = (await history(workspaceId, session)).json();
    expect(listed.cutoff).toBe(day.until);
    // The malformed legacy row is skipped rather than failing the list.
    expect(listed.briefings.map((item: { id: string }) => item.id)).toEqual([day.id, hour.id]);
  });
});
