import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  answerQuestionRequestSchema,
  cancelTaskRequestSchema,
  clientRequestIdSchema,
  listDiscussionQuerySchema,
  listTasksQuerySchema,
  postDiscussionRequestSchema,
  postTaskRequestSchema,
  startTaskRequestSchema,
  updateTaskRequestSchema,
  uuidSchema,
} from '@app/contracts';
import { parseOrThrow } from '../http/errors.js';
import type { PgDiscussionService } from '../discussion/service.js';
import type { PgTaskService } from './service.js';

/**
 * Task and discussion routes (design section 12.1).
 *
 * Every route validates its workspace and task IDs as UUIDs before touching
 * anything, so a caller cannot pass a path segment into a filesystem or room
 * name (section 12.1).
 */

const workspaceParams = z.object({ workspaceId: uuidSchema });
const taskParams = z.object({ workspaceId: uuidSchema, taskId: uuidSchema });

export interface TaskRouteDeps {
  tasks: PgTaskService;
  discussion: PgDiscussionService;
}

export async function registerTaskRoutes(
  app: FastifyInstance,
  deps: TaskRouteDeps,
): Promise<void> {
  // --- tasks ---------------------------------------------------------------

  /** Post only. No model call, no run, no agent (section 2.1). */
  app.post('/api/workspaces/:workspaceId/tasks', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const body = parseOrThrow(postTaskRequestSchema, request.body ?? {});
    const task = await deps.tasks.post(workspaceId, body);
    return reply.status(201).send(task);
  });

  app.get('/api/workspaces/:workspaceId/tasks', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const query = parseOrThrow(listTasksQuerySchema, request.query ?? {});
    return reply.send({ tasks: await deps.tasks.list(workspaceId, query) });
  });

  app.get('/api/workspaces/:workspaceId/tasks/:taskId', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    return reply.send(await deps.tasks.readTask(workspaceId, taskId));
  });

  app.patch('/api/workspaces/:workspaceId/tasks/:taskId', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    const body = parseOrThrow(updateTaskRequestSchema, request.body ?? {});
    return reply.send(await deps.tasks.revise(workspaceId, taskId, body));
  });

  /**
   * Start. Returns as soon as the run row is committed (section 2.2 step 3);
   * capture, planning, and dispatch happen in the orchestration hook after the
   * response, so a browser need not stay open.
   */
  app.post('/api/workspaces/:workspaceId/tasks/:taskId/start', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    const body = parseOrThrow(startTaskRequestSchema, request.body ?? {});
    const { run, taskStatus, idempotentReplay } = await deps.tasks.start(
      workspaceId,
      taskId,
      body,
    );
    return reply.status(202).send({
      runId: run.id,
      attempt: run.attempt,
      taskStatus,
      idempotentReplay,
    });
  });

  app.post('/api/workspaces/:workspaceId/tasks/:taskId/cancel', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    parseOrThrow(cancelTaskRequestSchema, request.body ?? {});
    return reply.send(await deps.tasks.cancel(workspaceId, taskId));
  });

  /** A new attempt at the current version, reusing existing agent budgets. */
  app.post('/api/workspaces/:workspaceId/tasks/:taskId/retry', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    const body = parseOrThrow(
      z.object({ clientRequestId: clientRequestIdSchema }),
      request.body ?? {},
    );
    const { run, idempotentReplay } = await deps.tasks.retry(workspaceId, taskId, body);
    return reply.status(202).send({
      runId: run.id,
      attempt: run.attempt,
      idempotentReplay,
    });
  });

  // --- discussion ----------------------------------------------------------

  app.get('/api/workspaces/:workspaceId/tasks/:taskId/discussion', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    const query = parseOrThrow(listDiscussionQuerySchema, request.query ?? {});
    return reply.send(await deps.discussion.list(workspaceId, taskId, query));
  });

  app.post('/api/workspaces/:workspaceId/tasks/:taskId/discussion', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    const body = parseOrThrow(postDiscussionRequestSchema, request.body ?? {});
    const entry = await deps.discussion.post(workspaceId, taskId, body);
    return reply.status(201).send(entry);
  });

  /** Answer an open agent question (section 2.6). */
  app.post('/api/workspaces/:workspaceId/tasks/:taskId/answer', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    const body = parseOrThrow(answerQuestionRequestSchema, request.body ?? {});
    return reply.send(await deps.discussion.answer(workspaceId, taskId, body));
  });
}
