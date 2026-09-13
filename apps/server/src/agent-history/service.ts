import { sql } from 'kysely';
import {
  ApiError, FINISHED_AGENT_STATUSES, agentHistoryDetailSchema, agentModelTurnContentSchema,
  agentToolResultsContentSchema, eventKeys, summarizeInstruction,
  type AgentHistoryDetail, type AgentHistoryEntry, type AgentTraceStep,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { LocalGitService } from '../git/service.js';

/** Enough to scroll a workspace's recent past; older agents stay in the task's own Agents tab. */
const LIST_LIMIT = 200;
const SUMMARY_MAX = 20_000;

/**
 * Agent histories (History screen): finished agents, what they thought and
 * did, and the files they changed.
 *
 * Read-only. Everything here comes from rows execution already wrote — the
 * trace (0013), the settlement events, and the agent's own commits — so a
 * history can never claim more than the records say.
 */
export class AgentHistoryService {
  constructor(private readonly deps: { db: Db; git: Pick<LocalGitService, 'compareCommits'> }) {}

  async list(workspaceId: string): Promise<AgentHistoryEntry[]> {
    await this.workspace(workspaceId);
    const rows = await this.baseQuery(workspaceId)
      .orderBy(sql`coalesce(a.ended_at, a.created_at)`, 'desc').orderBy('a.id')
      .limit(LIST_LIMIT).execute();
    return this.entries(rows);
  }

  async read(workspaceId: string, agentInstanceId: string): Promise<AgentHistoryDetail> {
    await this.workspace(workspaceId);
    const row = await this.baseQuery(workspaceId).where('a.id', '=', agentInstanceId).executeTakeFirst();
    if (!row) throw new ApiError('AGENT_NOT_FOUND', 'No finished agent with this ID in this workspace.');
    const [entry] = await this.entries([row]);
    const [outcomes, steps, changes] = await Promise.all([
      this.outcomes([row]),
      this.deps.db.selectFrom('agent_trace_steps').select(['id', 'kind', 'content', 'created_at'])
        .where('agent_instance_id', '=', row.id).orderBy('id').execute(),
      this.changes(workspaceId, row),
    ]);
    const outcome = outcomes.get(row.id);
    return agentHistoryDetailSchema.parse({
      agent: entry,
      limitations: outcome?.limitations ?? [],
      failureCode: outcome?.failureCode ?? null,
      steps: steps.flatMap((step): AgentTraceStep[] => {
        const base = { id: String(step.id), createdAt: step.created_at.toISOString() };
        // A row that no longer matches the shape is skipped, never shown half-parsed.
        if (step.kind === 'model_turn') {
          const content = agentModelTurnContentSchema.safeParse(step.content);
          return content.success ? [{ kind: 'model_turn', ...base, ...content.data }] : [];
        }
        const content = agentToolResultsContentSchema.safeParse(step.content);
        return content.success ? [{ kind: 'tool_results', ...base, ...content.data }] : [];
      }),
      changes,
    });
  }

  private async workspace(workspaceId: string) {
    const found = await this.deps.db.selectFrom('workspaces').select('id').where('id', '=', workspaceId).executeTakeFirst();
    if (!found) throw new ApiError('WORKSPACE_NOT_FOUND');
  }

  private baseQuery(workspaceId: string) {
    return this.deps.db.selectFrom('agent_instances as a')
      .innerJoin('tasks as t', 't.id', 'a.task_id')
      .innerJoin('runs as r', 'r.id', 'a.run_id')
      .select(['a.id', 'a.task_id', 'a.run_id', 'a.assignment_key', 'a.preset', 'a.status', 'a.instruction',
        'a.write_paths', 'a.base_sha', 'a.result_sha', 'a.started_at', 'a.ended_at', 't.title', 'r.attempt'])
      .where('a.workspace_id', '=', workspaceId)
      .where('t.workspace_id', '=', workspaceId)
      .where('a.status', 'in', [...FINISHED_AGENT_STATUSES]);
  }

  private async entries(rows: AgentRow[]): Promise<AgentHistoryEntry[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [outcomes, counts] = await Promise.all([
      this.outcomes(rows),
      this.deps.db.selectFrom('agent_trace_steps').select(['agent_instance_id', (eb) => eb.fn.countAll<number>().as('count')])
        .where('agent_instance_id', 'in', ids).groupBy('agent_instance_id').execute(),
    ]);
    const stepCounts = new Map(counts.map((count) => [count.agent_instance_id, Number(count.count)]));
    return rows.map((row) => ({
      agentInstanceId: row.id,
      taskId: row.task_id,
      taskTitle: row.title,
      runId: row.run_id,
      attempt: row.attempt,
      assignmentKey: row.assignment_key,
      preset: row.preset,
      status: row.status,
      instructionSummary: summarizeInstruction(row.instruction),
      writePaths: row.write_paths,
      startedAt: row.started_at?.toISOString() ?? null,
      endedAt: row.ended_at?.toISOString() ?? null,
      summary: outcomes.get(row.id)?.summary ?? null,
      stepCount: stepCounts.get(row.id) ?? 0,
    }));
  }

  /** Completion summaries and failure codes, from the settlement events only. */
  private async outcomes(rows: AgentRow[]) {
    const keys = rows.flatMap((row) => [eventKeys.agentSettled(row.id, 'completed'), eventKeys.agentSettled(row.id, 'failed')]);
    const events = keys.length ? await this.deps.db.selectFrom('task_events').select(['type', 'payload'])
      .where('task_id', 'in', [...new Set(rows.map((row) => row.task_id))])
      .where('event_key', 'in', keys).execute() : [];
    const result = new Map<string, { summary: string | null; limitations: string[]; failureCode: string | null }>();
    for (const event of events) {
      const agentId = event.payload.agentId;
      if (typeof agentId !== 'string') continue;
      const current = result.get(agentId) ?? { summary: null, limitations: [], failureCode: null };
      if (event.type === 'agent.failed' && typeof event.payload.code === 'string') current.failureCode = event.payload.code;
      if (event.type === 'agent.completed') {
        // Workers finish with `result`; the orchestrator completes with its `plan`.
        const record = asRecord(event.payload.result) ?? asRecord(event.payload.plan);
        if (typeof record?.summary === 'string') current.summary = record.summary.slice(0, SUMMARY_MAX);
        if (Array.isArray(record?.limitations)) {
          current.limitations = record.limitations.filter((item): item is string => typeof item === 'string');
        }
      }
      result.set(agentId, current);
    }
    return result;
  }

  private async changes(workspaceId: string, row: AgentRow): Promise<AgentHistoryDetail['changes']> {
    // Read-only presets and agents that never checkpointed changed nothing.
    if (!row.base_sha || !row.result_sha || row.result_sha === row.base_sha || !row.write_paths.length) {
      return { available: true, changedFiles: [] };
    }
    try {
      const changedFiles = await this.deps.git.compareCommits({
        workspaceId, beforeSha: row.base_sha, afterSha: row.result_sha, paths: row.write_paths,
      });
      return { available: true, changedFiles };
    } catch {
      // Missing objects are reported as unavailable, never as "no changes".
      return { available: false, changedFiles: [] };
    }
  }
}

type AgentRow = Awaited<ReturnType<ReturnType<AgentHistoryService['baseQuery']>['executeTakeFirstOrThrow']>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
