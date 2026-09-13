import { z } from 'zod';
import { repoPathSchema, reviewIdSchema, taskIdSchema, timestampSchema } from './ids.js';

/**
 * "Catch me up": a short briefing of what changed in a workspace.
 *
 * Every link in a briefing names a record by typed ID. The browser builds the
 * route from those IDs itself and never follows a server- or model-supplied
 * URL, so a briefing can point only at things the workspace actually holds.
 *
 * History is scoped to one workspace and one browser session. The session key
 * travels in a header, is stored only as a hash, and is deliberately separate
 * from the guest contributor ID, which collaborative editing broadcasts.
 */

export const BRIEFING_SESSION_HEADER = 'x-briefing-session';

export const BRIEFING_WINDOWS = ['since_last', 'last_hour', 'last_24h'] as const;
export const briefingWindowSchema = z.enum(BRIEFING_WINDOWS);
export type BriefingWindow = z.infer<typeof briefingWindowSchema>;

/** At most this many suggested next steps, whatever the model returns. */
export const MAX_BRIEFING_NEXT_STEPS = 3;

export const briefingLinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: taskIdSchema, label: z.string() }),
  z.object({ kind: z.literal('review'), taskId: taskIdSchema, reviewId: reviewIdSchema, label: z.string() }),
  z.object({
    kind: z.literal('file'),
    path: repoPathSchema,
    /** True when the path exists in the approved files right now. */
    approved: z.boolean(),
    /** The task whose drafts hold this path, for a file not yet approved. */
    taskId: taskIdSchema.nullable(),
    label: z.string(),
  }),
]);
export type BriefingLink = z.infer<typeof briefingLinkSchema>;

export const briefingItemSchema = z.object({
  text: z.string(),
  /** When the underlying activity happened; null for a generated statement. */
  at: timestampSchema.nullable(),
  links: z.array(briefingLinkSchema),
});
export type BriefingItem = z.infer<typeof briefingItemSchema>;

export const briefingAttentionItemSchema = briefingItemSchema.extend({
  kind: z.enum(['question', 'review']),
});
export type BriefingAttentionItem = z.infer<typeof briefingAttentionItemSchema>;

export const briefingSourceSchema = z.enum(['gemini', 'fallback', 'empty']);
export type BriefingSource = z.infer<typeof briefingSourceSchema>;

export const briefingFallbackReasonSchema = z.enum(['model_unavailable', 'model_failed', 'invalid_output']);
export type BriefingFallbackReason = z.infer<typeof briefingFallbackReasonSchema>;

export const briefingSchema = z.object({
  /** Null when nothing was recorded: an empty window or a fallback recap. */
  id: z.string().uuid().nullable(),
  window: briefingWindowSchema,
  since: timestampSchema,
  until: timestampSchema,
  /** The cutoff this session had before this briefing, if any. */
  previousCutoff: timestampSchema.nullable(),
  /** `since_last` with no earlier briefing falls back to the last 24 hours. */
  firstBriefing: z.boolean(),
  source: briefingSourceSchema,
  fallbackReason: briefingFallbackReasonSchema.nullable(),
  /** Counted from records, never generated. */
  stats: z.object({
    updates: z.number().int().nonnegative(),
    tasksTouched: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    openQuestions: z.number().int().nonnegative(),
    unresolvedReviews: z.number().int().nonnegative(),
  }),
  /** Generated and validated against records, or the factual recap on fallback. */
  changes: z.array(briefingItemSchema),
  /** Open questions and unresolved reviews, always read from records. */
  needsAttention: z.array(briefingAttentionItemSchema),
  /** Suggestions only. Nothing in a briefing performs an action. */
  nextSteps: z.array(briefingItemSchema).max(MAX_BRIEFING_NEXT_STEPS),
  /** The factual activity recap every briefing is built on. */
  activity: z.array(briefingItemSchema),
  /** True when this briefing moved the session's "since last briefing" cutoff. */
  cutoffAdvanced: z.boolean(),
  generatedAt: timestampSchema,
});
export type Briefing = z.infer<typeof briefingSchema>;

export const generateBriefingRequestSchema = z.object({ window: briefingWindowSchema }).strict();
export type GenerateBriefingRequest = z.infer<typeof generateBriefingRequestSchema>;

export const listBriefingsResponseSchema = z.object({
  /** The "since last briefing" cutoff for this session, or null before the first. */
  cutoff: timestampSchema.nullable(),
  /** Newest first. */
  briefings: z.array(briefingSchema),
});
export type ListBriefingsResponse = z.infer<typeof listBriefingsResponseSchema>;
