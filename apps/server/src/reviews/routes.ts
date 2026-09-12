import { z } from 'zod';
import { prepareReviewRequestSchema, resolveCandidateRequestSchema, reviewDetailSchema,
  reviewCandidateDataSchema, reviewPreviewSchema, uuidSchema, repoPathSchema,
  applyReviewRequestSchema, applyReviewResponseSchema, OWNER_KEY_HEADER } from '@app/contracts';
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '../http/errors.js';
import type { LocalReviewService } from './service.js';
import { readOwnerKeyHeader } from '../workspaces/owner-key.js';

const taskParams = z.object({ workspaceId: uuidSchema, taskId: uuidSchema });
const reviewParams = z.object({ workspaceId: uuidSchema, reviewId: uuidSchema });

/** Contributor routes; candidate and source identities come exclusively from the service. */
export async function registerReviewRoutes(app: FastifyInstance, reviews: LocalReviewService) {
  app.post('/api/workspaces/:workspaceId/reviews/:reviewId/apply', async (request) => {
    const params = parseOrThrow(reviewParams, request.params);
    const body = parseOrThrow(applyReviewRequestSchema.strict(), request.body);
    return applyReviewResponseSchema.parse(await reviews.apply({ ...params, candidateSha: body.candidateSha,
      ownerKey: readOwnerKeyHeader(request.headers[OWNER_KEY_HEADER]) }));
  });
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
}
