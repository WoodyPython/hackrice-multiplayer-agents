import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { openDraftRequestSchema, uuidSchema } from '@app/contracts';
import { parseOrThrow } from '../http/errors.js';
import type { PgDraftStore } from './store.js';

/**
 * Draft routes (design section 12.1).
 *
 * Deliberately only two, both reads or creates. Section 11.4 keeps browsers out
 * of storage, so there is no route that writes a Yjs snapshot: persist,
 * initialize, and closeEpoch are in-process calls the room server makes after
 * it has validated updates against the authoritative document. Exposing them
 * would let any link holder replace a document wholesale.
 */

const workspaceParams = z.object({ workspaceId: uuidSchema });
const taskParams = z.object({ workspaceId: uuidSchema, taskId: uuidSchema });

export interface DraftRouteDeps {
  drafts: PgDraftStore;
}

export async function registerDraftRoutes(
  app: FastifyInstance,
  deps: DraftRouteDeps,
): Promise<void> {
  /**
   * "Edit together" (section 2.5). Find-or-create, so concurrent clicks on the
   * same file converge on one editing task rather than forking the draft.
   */
  app.post('/api/workspaces/:workspaceId/drafts/open', async (request, reply) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    const body = parseOrThrow(openDraftRequestSchema, request.body ?? {});
    const result = await deps.drafts.openManualEdit(workspaceId, body);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  /** Active documents in a task, for the editor's file selector (section 4.4). */
  app.get('/api/workspaces/:workspaceId/tasks/:taskId/drafts', async (request, reply) => {
    const { workspaceId, taskId } = parseOrThrow(taskParams, request.params);
    return reply.send({
      drafts: await deps.drafts.listActiveForTask(workspaceId, taskId),
    });
  });
}
