import { z } from 'zod';
import { agentHistoryDetailSchema, listAgentHistoryResponseSchema, uuidSchema } from '@app/contracts';
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '../http/errors.js';
import type { AgentHistoryService } from './service.js';

const workspaceParams = z.object({ workspaceId: uuidSchema });
const agentParams = z.object({ workspaceId: uuidSchema, agentInstanceId: uuidSchema });

/**
 * Agent histories for the History screen. Responses are parsed on the way out
 * so the schema stays a whitelist: model IDs, raw instructions and provider
 * state cannot reach the browser through a field added to a row later.
 */
export async function registerAgentHistoryRoutes(app: FastifyInstance, history: AgentHistoryService) {
  app.get('/api/workspaces/:workspaceId/agent-history', async (request) => {
    const { workspaceId } = parseOrThrow(workspaceParams, request.params);
    return listAgentHistoryResponseSchema.parse({ agents: await history.list(workspaceId) });
  });
  app.get('/api/workspaces/:workspaceId/agent-history/:agentInstanceId', async (request) => {
    const { workspaceId, agentInstanceId } = parseOrThrow(agentParams, request.params);
    return agentHistoryDetailSchema.parse(await history.read(workspaceId, agentInstanceId));
  });
}
