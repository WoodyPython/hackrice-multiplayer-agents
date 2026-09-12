import { z } from 'zod';
import {
  repoPathSchema,
  reviewIdSchema,
  runIdSchema,
  shaSchema,
  taskIdSchema,
  timestampSchema,
} from './ids.js';
import { applyStatusSchema, reviewStatusSchema } from './enums.js';
import { documentRevisionsSchema } from './draft.js';

/**
 * Design section 12.3, `ReviewSource`, and section 10.1's source tuple.
 *
 * Apply re-validates every field of this against live state (section 10.3).
 * `resultSha` is null for a manual-edit task, where G is absent.
 */
export const reviewSourceSchema = z.object({
  taskVersion: z.number().int().positive(),
  guidanceVersion: z.number().int().positive(),
  mainSha: shaSchema,
  humanSha: shaSchema,
  resultSha: shaSchema.nullable(),
  documentRevisions: documentRevisionsSchema,
  contextHash: z.string(),
});
export type ReviewSource = z.infer<typeof reviewSourceSchema>;

export const reviewSchema = z.object({
  id: reviewIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema.nullable(),
  source: reviewSourceSchema,
  /** The exact commit the owner is approving. Null only while building. */
  candidateSha: shaSchema.nullable(),
  status: reviewStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Review = z.infer<typeof reviewSchema>;

/**
 * Section 10.2: "'Current' must identify whether it means the human draft or
 * approved workspace; never label both simply 'ours'."
 */
export const conflictSideSchema = z.enum([
  'human_draft',
  'agent_result',
  'approved_main',
]);
export type ConflictSide = z.infer<typeof conflictSideSchema>;

export const reviewFileConflictSchema = z.object({
  path: repoPathSchema,
  sides: z.array(
    z.object({
      side: conflictSideSchema,
      text: z.string().nullable(),
      sha: shaSchema.nullable(),
    }),
  ),
});
export type ReviewFileConflict = z.infer<typeof reviewFileConflictSchema>;

/**
 * Section 10.2: a resolution creates a NEW candidate. It never edits the
 * previously approved candidate in place.
 */
export const resolveReviewRequestSchema = z.object({
  resolutions: z
    .array(
      z.object({
        path: repoPathSchema,
        choice: z.union([conflictSideSchema, z.literal('manual')]),
        /** Required when choice is 'manual'. */
        text: z.string().optional(),
      }),
    )
    .min(1),
}).refine(
  (v) => v.resolutions.every((r) => r.choice !== 'manual' || r.text !== undefined),
  { message: 'manual resolution requires text' },
);
export type ResolveReviewRequest = z.infer<typeof resolveReviewRequestSchema>;

/**
 * Section 10.3. Owner key travels in the header, not the body: an `isOwner`
 * flag or claimed creator ID is never accepted (section 12.2).
 */
export const applyReviewRequestSchema = z.object({
  /** Must equal the review's stored candidate, so a refreshed review is not
   *  applied by a browser that was looking at the previous one. */
  candidateSha: shaSchema,
  clientRequestId: z.string().min(1).max(200).optional(),
});
export type ApplyReviewRequest = z.infer<typeof applyReviewRequestSchema>;

export const applyReviewResponseSchema = z.object({
  status: applyStatusSchema,
  appliedCommitSha: shaSchema.nullable(),
  /** True when reconciliation found the candidate already on main (section 10.5). */
  alreadyApplied: z.boolean(),
});
export type ApplyReviewResponse = z.infer<typeof applyReviewResponseSchema>;

/**
 * Section 10.4. Every generated claim stays distinguishable from a measured
 * fact, and each AI finding names the snapshot it examined.
 */
export const reviewEvidenceSchema = z.object({
  changedFiles: z.array(
    z.object({
      path: z.string(),
      changeKind: z.enum(['added', 'modified', 'deleted']),
      diff: z.string(),
    }),
  ),
  /** Labeled as generated wherever it is rendered. */
  agentSummaries: z.array(
    z.object({
      agentKey: z.string(),
      summary: z.string(),
      limitations: z.string().nullable(),
      examinedSha: shaSchema.nullable(),
      /** True when the candidate moved on since this finding was recorded. */
      staleAgainstCandidate: z.boolean(),
    }),
  ),
  /** Checks the server actually performed, not checks a model claimed to run. */
  validationsPerformed: z.array(
    z.object({ check: z.string(), passed: z.boolean(), detail: z.string().nullable() }),
  ),
  /** Section 10.4 requires this notice to be explicit. */
  generatedCodeWasNotExecuted: z.literal(true),
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

// D06: existing shared shapes remain available; these describe the complete wire surface.
export const prepareReviewRequestSchema = z.object({}).strict();
export const reviewMergeStageSchema = z.enum(['human_agent', 'task_main']);
export const reviewCandidateSideSchema = z.union([conflictSideSchema, z.literal('combined_task')]);
export const candidateConflictSchema = z.object({
  path: repoPathSchema,
  stage: reviewMergeStageSchema,
  sides: z.array(z.object({ side: reviewCandidateSideSchema, text: z.string().nullable(), sha: shaSchema.nullable() })),
});
export const candidateResolutionSchema = z.object({
  path: repoPathSchema,
  choice: z.union([reviewCandidateSideSchema, z.literal('manual')]),
  text: z.string().optional(),
}).strict().refine((r) => r.choice === 'manual' ? r.text !== undefined : r.text === undefined,
  { message: 'Only manual resolution accepts text, and requires it.' });
export const resolveCandidateRequestSchema = z.object({
  expectedCandidateSha: shaSchema,
  resolutions: z.array(candidateResolutionSchema).min(1),
}).strict().refine((r) => new Set(r.resolutions.map((v) => v.path)).size === r.resolutions.length,
  { message: 'Resolution paths must be unique.' });
export const reviewChangedFileSchema = z.object({
  path: repoPathSchema, changeKind: z.enum(['added', 'modified', 'deleted']), diff: z.string(),
  beforeHash: shaSchema.nullable(), afterHash: shaSchema.nullable(),
});
export const reviewCandidateDataSchema = z.object({
  candidateSha: shaSchema,
  candidateComplete: z.boolean(),
  conflicts: z.array(candidateConflictSchema),
  changedFiles: z.array(reviewChangedFileSchema),
  generatedCodeWasNotExecuted: z.literal(true),
});
export const reviewDetailSchema = reviewCandidateDataSchema.extend({ review: reviewSchema });
export const reviewPreviewSchema = z.object({
  candidateSha: shaSchema, candidateComplete: z.boolean(), path: repoPathSchema,
  text: z.string().nullable(), hash: shaSchema.nullable(),
});
export type CandidateConflict = z.infer<typeof candidateConflictSchema>;
export type CandidateResolution = z.infer<typeof candidateResolutionSchema>;
export type ResolveCandidateRequest = z.infer<typeof resolveCandidateRequestSchema>;
export type ReviewCandidateData = z.infer<typeof reviewCandidateDataSchema>;
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;
