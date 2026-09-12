import { z } from 'zod';
import { ApiError, prepareReviewRequestSchema, resolveCandidateRequestSchema, reviewDetailSchema,
  reviewCandidateDataSchema, reviewPreviewSchema, reviewEvidenceSchema, reviewAssessmentSchema,
  uuidSchema, repoPathSchema, type ReviewAssessmentService } from '@app/contracts';
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '../http/errors.js';
import type { LocalReviewService } from './service.js';
import { ReviewAssessmentError } from '../orchestration/review-assessment.js';
import type { ReviewEvidenceComposer } from '../orchestration/review-evidence.js';

/** Section 12.5: an actionable code, not the generic 500 an unrecognized error
 * class would otherwise fall through to. */
function assessmentApiError(error: ReviewAssessmentError): ApiError {
  switch (error.code) {
    case 'not_found': return new ApiError('REVIEW_NOT_FOUND', 'No such review in this workspace.');
    case 'timed_out': return new ApiError('AGENT_TIMED_OUT', 'The reviewer did not finish in time. Try again.');
    case 'token_exhausted': return new ApiError('AGENT_TOKEN_EXHAUSTED', 'This review has no assessment budget left.');
    case 'blocked_response': case 'invalid_response':
      return new ApiError('INVALID_STATE', 'The reviewer could not produce a usable finding. Try again.');
  }
}

const taskParams = z.object({ workspaceId: uuidSchema, taskId: uuidSchema });
const reviewParams = z.object({ workspaceId: uuidSchema, reviewId: uuidSchema });

/**
 * Contributor routes; candidate and source identities come exclusively from
 * the service. `evidence`/`assess` are C07's additions: the review candidate
 * itself stays D06's, so both read it through `reviews.read` rather than
 * touching Git directly.
 */
export async function registerReviewRoutes(app: FastifyInstance, reviews: LocalReviewService,
  c07: { evidence: ReviewEvidenceComposer; assessments: ReviewAssessmentService }) {
  app.post('/api/workspaces/:workspaceId/tasks/:taskId/review', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    parseOrThrow(prepareReviewRequestSchema, request.body === undefined ? {} : request.body);
    return reply.code(200).send(reviewDetailSchema.parse(await reviews.prepare(workspaceId, taskId)));
  });
  app.post('/api/workspaces/:workspaceId/reviews/:reviewId/resolve', async (request, reply) => {
    const { workspaceId, reviewId } = parseOrThrow(reviewParams, request.params);
    const input = parseOrThrow(resolveCandidateRequestSchema, request.body);
    return reply.code(200).send(reviewDetailSchema.parse(await reviews.resolve(workspaceId, reviewId, input)));
  });
  app.get('/api/workspaces/:workspaceId/reviews/:reviewId', async (request) => {
    const { workspaceId, reviewId } = parseOrThrow(reviewParams, request.params);
    return reviewDetailSchema.parse(await reviews.read(workspaceId, reviewId));
  });
  app.get('/api/workspaces/:workspaceId/reviews/:reviewId/diff', async (request) => {
    const { workspaceId, reviewId } = parseOrThrow(reviewParams, request.params);
    return reviewCandidateDataSchema.parse(await reviews.read(workspaceId, reviewId));
  });
  app.get('/api/workspaces/:workspaceId/reviews/:reviewId/preview', async (request) => {
    const { workspaceId, reviewId } = parseOrThrow(reviewParams, request.params);
    const { path } = parseOrThrow(z.object({ path: repoPathSchema }).strict(), request.query);
    return reviewPreviewSchema.parse(await reviews.preview(workspaceId, reviewId, path));
  });
  // C07: real changed-file data plus labeled generated claims (section 10.4).
  app.get('/api/workspaces/:workspaceId/reviews/:reviewId/evidence', async (request) => {
    const { workspaceId, reviewId } = parseOrThrow(reviewParams, request.params);
    const detail = await reviews.read(workspaceId, reviewId);
    return reviewEvidenceSchema.parse(await c07.evidence.compose({
      workspaceId, taskId: detail.review.taskId, reviewId,
      candidateSha: detail.candidateSha, candidateComplete: detail.candidateComplete,
      unresolvedConflicts: detail.conflicts.length, changedFiles: detail.changedFiles,
      runId: detail.review.runId, source: { mainSha: detail.review.source.mainSha, humanSha: detail.review.source.humanSha },
    }));
  });
  // A fresh reviewer pass against the exact candidate held right now. No body:
  // there is nothing for a caller to supply beyond which review to assess.
  app.post('/api/workspaces/:workspaceId/reviews/:reviewId/assess', async (request, reply) => {
    const { workspaceId, reviewId } = parseOrThrow(reviewParams, request.params);
    parseOrThrow(prepareReviewRequestSchema, request.body === undefined ? {} : request.body);
    const detail = await reviews.read(workspaceId, reviewId);
    try {
      const result = await c07.assessments.assess({ workspaceId, taskId: detail.review.taskId, reviewId });
      return reply.code(200).send(reviewAssessmentSchema.parse(result));
    } catch (error) {
      throw error instanceof ReviewAssessmentError ? assessmentApiError(error) : error;
    }
  });
}
