import { z } from 'zod';
import {
  agentInstanceIdSchema,
  clientRequestIdSchema,
  discussionEntryIdSchema,
  guestLabelSchema,
  materialIdSchema,
  questionIdSchema,
  runIdSchema,
  taskIdSchema,
  timestampSchema,
} from './ids.js';
import { actorTypeSchema, questionStatusSchema } from './enums.js';

/**
 * Task-local discussion (section 1.1). There is no workspace-wide chat and no
 * cross-task thread.
 */
export const discussionEntrySchema = z.object({
  id: discussionEntryIdSchema,
  taskId: taskIdSchema,
  /**
   * Gap-free per-task order, allocated under the task row lock. Sequence order
   * equals commit order, which is what makes a run's discussion cutoff exact
   * (section 2.3).
   */
  seq: z.number().int().positive(),
  actorType: actorTypeSchema,
  /** Present only for guest entries. Unverified (section 1.3). */
  guestLabel: z.string().nullable(),
  body: z.string(),
  createdAt: timestampSchema,
  /** Materials attached to this entry. */
  materialIds: z.array(materialIdSchema),
  /**
   * Set when this entry displays an agent question, or answers one. Lets the
   * UI render the question/answer pair without a second request.
   */
  question: z
    .object({
      id: questionIdSchema,
      status: questionStatusSchema,
      /** 'asked' when this entry IS the question, 'answer' when it answers one. */
      role: z.enum(['asked', 'answer']),
    })
    .nullable(),
  /**
   * True when seq is above the active run's discussion cutoff. Section 2.3:
   * the UI labels these "Added after this run started".
   */
  afterActiveRunCutoff: z.boolean(),
});
export type DiscussionEntry = z.infer<typeof discussionEntrySchema>;

// --- read ------------------------------------------------------------------

/** Cursor pagination by seq. Stable across refresh and reconnect. */
export const listDiscussionQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListDiscussionQuery = z.infer<typeof listDiscussionQuerySchema>;

export const listDiscussionResponseSchema = z.object({
  entries: z.array(discussionEntrySchema),
  /** Highest seq in the task right now, so a client knows if it is behind. */
  latestSeq: z.number().int().nonnegative(),
  /** Cutoff of the active run, if any. Null when no run is active. */
  activeRunCutoffSeq: z.number().int().nonnegative().nullable(),
});
export type ListDiscussionResponse = z.infer<typeof listDiscussionResponseSchema>;

// --- write -----------------------------------------------------------------

/**
 * A guest comment. `clientRequestId` makes a double-tap a no-op rather than a
 * duplicate entry (section 11.2).
 */
export const postDiscussionRequestSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  guestLabel: guestLabelSchema,
  /** Existing materials to attach. Upload happens separately (B04). */
  materialIds: z.array(materialIdSchema).max(20).default([]),
  clientRequestId: clientRequestIdSchema.optional(),
});
export type PostDiscussionRequest = z.infer<typeof postDiscussionRequestSchema>;

// --- agent questions (section 2.6) -----------------------------------------

export const agentQuestionSchema = z.object({
  id: questionIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  agentInstanceId: agentInstanceIdSchema,
  /** The discussion entry that displays the question. */
  questionEntryId: discussionEntryIdSchema,
  answerEntryId: discussionEntryIdSchema.nullable(),
  status: questionStatusSchema,
  askedAt: timestampSchema,
  /**
   * The asking agent's existing deadline. Waiting for a human consumes that
   * clock; asking never extends it (section 9.2).
   */
  expiresAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
});
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

/**
 * Answering records an ordinary discussion entry, links it to the question, and
 * marks the question answered, all in one transaction.
 *
 * The answer is above the run's discussion cutoff and reaches the waiting agent
 * anyway: it is a reply to a question the run itself asked, routed through the
 * question record rather than through discussion context.
 */
export const answerQuestionRequestSchema = z.object({
  questionId: questionIdSchema,
  body: z.string().trim().min(1).max(20000),
  guestLabel: guestLabelSchema,
  clientRequestId: clientRequestIdSchema.optional(),
});
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequestSchema>;

export const answerQuestionResponseSchema = z.object({
  question: agentQuestionSchema,
  answerEntry: discussionEntrySchema,
});
export type AnswerQuestionResponse = z.infer<typeof answerQuestionResponseSchema>;

/** What an agent supplies when calling the ask_question tool (section 8.6). */
export const askQuestionInputSchema = z.object({
  agentInstanceId: agentInstanceIdSchema,
  body: z.string().trim().min(1).max(20000),
});
export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;
