import { createHash } from 'node:crypto';
import {
  ApiError,
  briefingSchema,
  type Briefing,
  type BriefingFallbackReason,
  type BriefingWindow,
  type ListBriefingsResponse,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import { ModelAdapterError, type ModelAdapter } from '../models/types.js';
import { collectActivity, type BriefingSources } from './activity.js';
import {
  BRIEFING_RESPONSE_SCHEMA,
  BRIEFING_SYSTEM_INSTRUCTION,
  FALLBACK_CHANGE_LIMIT,
  InvalidBriefingOutput,
  activityItems,
  attentionItems,
  briefingPrompt,
  briefingStats,
  indexSnapshot,
  validateBriefingOutput,
} from './compose.js';

/**
 * "Catch me up" (workspace briefings).
 *
 * Reads records, asks Gemini to summarize them, validates the answer against
 * those same records, and stores the result for one browser session. It never
 * writes anything else: no task, review, discussion, or event is touched, and
 * nothing a briefing suggests is carried out.
 *
 * The cutoff behind "since last briefing" is the end of the newest stored
 * briefing that covered the whole gap since the previous cutoff. Only a
 * successful Gemini generation is stored, so an empty window or a fallback
 * recap leaves the cutoff where it was and the next attempt covers the same
 * ground again.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A long-absent session is briefed on two weeks, not on everything ever. */
const MAX_WINDOW_MS = 14 * DAY_MS;
const MODEL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 8192;
const HISTORY_LIMIT = 10;
const RETAINED_PER_SESSION = 20;

export interface BriefingServiceDeps {
  db: Db;
  adapter: Pick<ModelAdapter, 'getModel' | 'generate'>;
  sources?: BriefingSources;
  now?: () => Date;
  timeoutMs?: number;
  /** Server-log only; receives the reason, never provider text or prompts. */
  onModelFailure?: (info: { workspaceId: string; reason: BriefingFallbackReason; code?: string }) => void;
}

export function hashBriefingSession(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

export class BriefingService {
  private readonly inFlight = new Map<string, Promise<Briefing>>();

  constructor(private readonly deps: BriefingServiceDeps) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  async list(workspaceId: string, sessionKey: string): Promise<ListBriefingsResponse> {
    await this.requireWorkspace(workspaceId);
    const viewer = hashBriefingSession(sessionKey);
    const [rows, cutoff] = await Promise.all([
      this.deps.db.selectFrom('workspace_briefings').select(['id', 'content'])
        .where('workspace_id', '=', workspaceId).where('viewer_hash', '=', viewer)
        .orderBy('created_at', 'desc').limit(HISTORY_LIMIT).execute(),
      this.cutoff(workspaceId, viewer),
    ]);
    const briefings = rows.flatMap((row) => {
      // A stored shape from an older build is skipped rather than failing the page.
      const parsed = briefingSchema.safeParse({ ...row.content, id: row.id });
      return parsed.success ? [parsed.data] : [];
    });
    return { cutoff: cutoff?.toISOString() ?? null, briefings };
  }

  /** Identical concurrent requests from one session share a single generation. */
  generate(workspaceId: string, sessionKey: string, window: BriefingWindow): Promise<Briefing> {
    const viewer = hashBriefingSession(sessionKey);
    const key = `${workspaceId}:${viewer.toString('hex')}:${window}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.run(workspaceId, viewer, window).finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async run(workspaceId: string, viewer: Buffer, window: BriefingWindow): Promise<Briefing> {
    await this.requireWorkspace(workspaceId);
    const until = this.now();
    const previousCutoff = await this.cutoff(workspaceId, viewer);
    const baseline = previousCutoff ?? new Date(until.getTime() - DAY_MS);
    const since = window === 'last_hour' ? new Date(until.getTime() - HOUR_MS)
      : window === 'last_24h' ? new Date(until.getTime() - DAY_MS)
        : new Date(Math.max(baseline.getTime(), until.getTime() - MAX_WINDOW_MS));

    const snapshot = await collectActivity(this.deps.db, workspaceId, since, until, this.deps.sources);
    const index = indexSnapshot(snapshot);
    const activity = activityItems(index);
    const base = {
      window, since: since.toISOString(), until: until.toISOString(),
      previousCutoff: previousCutoff?.toISOString() ?? null,
      firstBriefing: previousCutoff === null,
      stats: briefingStats(snapshot),
      needsAttention: attentionItems(index),
      activity,
      generatedAt: until.toISOString(),
    };

    if (activity.length === 0) {
      return briefingSchema.parse({ ...base, id: null, source: 'empty', fallbackReason: null,
        changes: [], nextSteps: [], cutoffAdvanced: false });
    }

    let generated: { changes: Briefing['changes']; nextSteps: Briefing['nextSteps'] };
    try {
      generated = await this.ask(index);
    } catch (error) {
      const reason: BriefingFallbackReason = error instanceof InvalidBriefingOutput ? 'invalid_output'
        : error instanceof ModelAdapterError && error.code === 'configuration' ? 'model_unavailable' : 'model_failed';
      this.deps.onModelFailure?.({ workspaceId, reason, ...(error instanceof ModelAdapterError ? { code: error.code } : {}) });
      return briefingSchema.parse({ ...base, id: null, source: 'fallback', fallbackReason: reason,
        changes: activity.slice(0, FALLBACK_CHANGE_LIMIT), nextSteps: [], cutoffAdvanced: false });
    }

    // "Since last briefing" always catches the session up. A fixed window does
    // only when it reaches back past the previous cutoff; otherwise it would
    // silently skip whatever happened between the two.
    const advances = window === 'since_last' || since.getTime() <= baseline.getTime();
    const content = briefingSchema.parse({ ...base, id: null, source: 'gemini', fallbackReason: null,
      ...generated, cutoffAdvanced: advances });

    const id = await this.deps.db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('workspace_briefings').values({
        workspace_id: workspaceId, viewer_hash: viewer, window_mode: window,
        window_start: since, window_end: until, advances_cutoff: advances,
        content: { ...content, id: undefined },
      }).returning('id').executeTakeFirstOrThrow();
      const retained = trx.selectFrom('workspace_briefings').select('id')
        .where('workspace_id', '=', workspaceId).where('viewer_hash', '=', viewer)
        .orderBy('created_at', 'desc').limit(RETAINED_PER_SESSION);
      await trx.deleteFrom('workspace_briefings')
        .where('workspace_id', '=', workspaceId).where('viewer_hash', '=', viewer)
        .where('id', 'not in', retained).execute();
      return row.id;
    });
    return { ...content, id };
  }

  private async ask(index: ReturnType<typeof indexSnapshot>) {
    const profile = this.deps.adapter.getModel('analyst');
    const maxOutputTokens = Math.min(profile.maxOutputTokens, MAX_OUTPUT_TOKENS);
    if (maxOutputTokens < profile.minOutputTokens) throw new ModelAdapterError('configuration', 'Model bounds are too small.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? MODEL_TIMEOUT_MS);
    timer.unref?.();
    // The adapter honours the signal, but the person waiting must not depend on
    // that: the deadline is enforced here as well.
    const timedOut = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort',
      () => reject(new ModelAdapterError('aborted', 'Briefing generation timed out.')), { once: true }));
    try {
      const generation = this.deps.adapter.generate({
        preset: 'analyst',
        systemInstruction: BRIEFING_SYSTEM_INSTRUCTION,
        responseJsonSchema: BRIEFING_RESPONSE_SCHEMA,
        messages: [{ role: 'user', text: briefingPrompt(index) }],
      }, { maxOutputTokens }, controller.signal);
      generation.catch(() => undefined);
      timedOut.catch(() => undefined);
      const response = await Promise.race([generation, timedOut]);
      if (response.blockReason || response.finishReason !== 'STOP') throw new InvalidBriefingOutput('incomplete response');
      return validateBriefingOutput(index, response.text);
    } finally {
      clearTimeout(timer);
    }
  }

  private async cutoff(workspaceId: string, viewer: Buffer): Promise<Date | null> {
    const row = await this.deps.db.selectFrom('workspace_briefings')
      .select((eb) => eb.fn.max('window_end').as('cutoff'))
      .where('workspace_id', '=', workspaceId).where('viewer_hash', '=', viewer).where('advances_cutoff', '=', true)
      .executeTakeFirst();
    const value = row?.cutoff as Date | string | null | undefined;
    return value ? new Date(value) : null;
  }

  private async requireWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.deps.db.selectFrom('workspaces').select('id').where('id', '=', workspaceId).executeTakeFirst();
    if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');
  }
}
