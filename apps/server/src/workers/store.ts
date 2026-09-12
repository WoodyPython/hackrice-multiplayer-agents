import { isDeepStrictEqual } from 'node:util';
import { contextManifestSchema, eventKeys, type PlanningContext, type WorkerResult } from '@app/contracts';
import { AgentExecutionError, PgAgentLedger } from '../agents/index.js';
import type { Db } from '../db/client.js';
import { appendEvent } from '../events/service.js';
import { isPermittedWritePath } from '../orchestration/validate-plan.js';

export class WorkerToolError extends Error {
  override readonly name = 'WorkerToolError';
  constructor(readonly code: string) { super(`Worker tool refused (${code}).`); }
}

export class PgWorkerStore {
  constructor(readonly db: Db, readonly ledger: PgAgentLedger, private readonly now = () => new Date()) {}

  async bind(id: string, context: PlanningContext) {
    const agent = await this.ledger.assertActive(id);
    const run = await this.db.selectFrom('runs').selectAll().where('id', '=', agent.run_id).executeTakeFirstOrThrow();
    const manifest = contextManifestSchema.parse(run.context_manifest);
    if (!agent.base_sha || !run.input_snapshot_sha || agent.preset === 'orchestrator' ||
        context.task.id !== agent.task_id || context.task.version !== run.task_version ||
        context.manifest.taskVersion !== run.task_version || context.manifest.guidanceVersion !== run.guidance_version ||
        context.manifest.discussionCutoffSeq !== run.discussion_cutoff_seq ||
        context.discussion.some((entry) => entry.seq > run.discussion_cutoff_seq) ||
        !isDeepStrictEqual(manifest, context.manifest)) throw new WorkerToolError('context_mismatch');
    if (agent.write_paths.some((path) => !isPermittedWritePath(path)) ||
        (['analyst', 'reviewer'].includes(agent.preset) && agent.write_paths.length)) throw new WorkerToolError('invalid_scope');
    const prerequisites = await this.db.selectFrom('agent_dependencies as d')
      .innerJoin('agent_instances as a', 'a.id', 'd.prerequisite_agent_id')
      .select(['a.id', 'a.assignment_key', 'a.status', 'a.write_paths', 'a.result_sha'])
      .where('d.agent_id', '=', id).where('d.run_id', '=', agent.run_id).execute();
    if (prerequisites.some((p) => p.status !== 'completed')) throw new AgentExecutionError('prerequisites_pending');
    const completions = prerequisites.length ? await this.db.selectFrom('task_events')
      .select(['event_key', 'payload']).where('run_id', '=', agent.run_id)
      .where('event_key', 'in', prerequisites.map((p) => eventKeys.agentSettled(p.id, 'completed'))).execute() : [];
    const prerequisiteResults = prerequisites.map((p) => {
      const result = completions.find((event) => event.event_key === eventKeys.agentSettled(p.id, 'completed'))?.payload.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WorkerToolError('prerequisite_result_unavailable');
      // These are generated claims/evidence, never additional authority. Only
      // completion fields enter the prompt, not arbitrary event metadata.
      const value = result as Record<string, unknown>;
      return { assignmentKey: p.assignment_key, summary: value.summary, references: value.references,
        limitations: value.limitations, artifacts: value.artifacts, resultSha: p.result_sha };
    });
    return { agent, manifest, inputSnapshotSha: run.input_snapshot_sha,
      prerequisiteResults,
      workerReadPaths: [...new Set([...agent.write_paths, ...manifest.approvedPaths,
        ...Object.keys(manifest.draftFileHashes), ...prerequisites.flatMap((p) => p.write_paths)])] };
  }

  /** No Git call is made while waiting for these DB locks. Git invokes this
   * boundary while it already holds the workspace lock and has a candidate.
   */
  async checkpoint(id: string, scope: string[], checkpoint: { commitSha: string; changedPaths: string[] },
    publish: () => Promise<void>, signal: AbortSignal) {
    await this.ledger.withActiveWrite(id, async (trx, agent) => {
      signal.throwIfAborted();
      if (!['writer', 'coder'].includes(agent.preset) || !isDeepStrictEqual(agent.write_paths, scope) ||
          checkpoint.changedPaths.some((path) => !scope.includes(path))) throw new WorkerToolError('scope_violation');
      // Acceptance linearizes here, while cancellation/supersession are locked
      // out. Git remains the recovery authority if DB commit/projection fails.
      await publish();
      await trx.updateTable('agent_instances').set({ result_sha: checkpoint.commitSha }).where('id', '=', id).execute();
      await appendEvent(trx, { workspaceId: agent.workspace_id, taskId: agent.task_id, runId: agent.run_id,
        eventKey: `agent:${id}:checkpoint:${checkpoint.commitSha}`, type: 'agent.checkpointed',
        payload: { agentId: id, ...checkpoint } });
    });
  }

  async ask(id: string, body: string, signal: AbortSignal) {
    return this.ledger.withActiveWrite(id, async (trx, agent) => {
      signal.throwIfAborted();
      const existing = await trx.selectFrom('agent_questions').select('id')
        .where('agent_instance_id', '=', id).where('status', '=', 'open').executeTakeFirst();
      if (existing) throw new WorkerToolError('question_already_open');
      const task = await trx.updateTable('tasks').set((eb) => ({
        discussion_seq: eb('discussion_seq', '+', 1), status: 'needs_input', updated_at: this.now(),
      })).where('id', '=', agent.task_id).returning('discussion_seq').executeTakeFirstOrThrow();
      const entry = await trx.insertInto('discussion_entries').values({ workspace_id: agent.workspace_id,
        task_id: agent.task_id, seq: task.discussion_seq, actor_type: 'agent', guest_label: null,
        body, client_request_id: null }).returning('id').executeTakeFirstOrThrow();
      const question = await trx.insertInto('agent_questions').values({ workspace_id: agent.workspace_id,
        task_id: agent.task_id, run_id: agent.run_id, agent_instance_id: id,
        question_entry_id: entry.id, expires_at: agent.deadline_at!,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('agent_instances').set({ status: 'needs_input' }).where('id', '=', id).execute();
      await trx.updateTable('runs').set({ status: 'needs_input' }).where('id', '=', agent.run_id).execute();
      await appendEvent(trx, { workspaceId: agent.workspace_id, taskId: agent.task_id, runId: agent.run_id,
        eventKey: eventKeys.agentWaiting(question.id), type: 'agent.waiting', payload: { agentId: id, questionId: question.id } });
      return question.id;
    });
  }

  async answer(id: string, questionId: string, signal: AbortSignal): Promise<string | null> {
    return this.ledger.withActiveWrite(id, async (trx) => {
      signal.throwIfAborted();
      const question = await trx.selectFrom('agent_questions').selectAll()
        .where('id', '=', questionId).where('agent_instance_id', '=', id).executeTakeFirstOrThrow();
      if (question.status === 'open') return null;
      if (question.status !== 'answered' || !question.answer_entry_id) throw new WorkerToolError('question_closed');
      const entry = await trx.selectFrom('discussion_entries').select('body')
        .where('id', '=', question.answer_entry_id).where('task_id', '=', question.task_id).executeTakeFirstOrThrow();
      await trx.updateTable('agent_instances').set({ status: 'running' }).where('id', '=', id).execute();
      return entry.body;
    });
  }

  async finish(id: string, result: WorkerResult, signal: AbortSignal) {
    return this.ledger.withActiveWrite(id, async (trx, agent) => {
      signal.throwIfAborted();
      if (result.resultSha !== (agent.result_sha ?? agent.base_sha)) throw new WorkerToolError('checkpoint_changed');
      const checkpoints = await trx.selectFrom('task_events').select('payload')
        .where('run_id', '=', agent.run_id).where('event_key', 'like', `agent:${id}:checkpoint:%`).execute();
      const changedPaths = new Set<string>();
      for (const checkpoint of checkpoints) {
        const paths = checkpoint.payload.changedPaths;
        if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) throw new WorkerToolError('invalid_checkpoint');
        paths.forEach((path: string) => changedPaths.add(path));
      }
      if (result.artifacts.length !== changedPaths.size || new Set(result.artifacts.map((a) => a.path)).size !== changedPaths.size ||
          result.artifacts.some((a) => !changedPaths.has(a.path) || !agent.write_paths.includes(a.path))) {
        throw new WorkerToolError('invalid_artifacts');
      }
      const open = await trx.selectFrom('agent_questions').select('id')
        .where('agent_instance_id', '=', id).where('status', '=', 'open').executeTakeFirst();
      if (open) throw new WorkerToolError('question_already_open');
      await appendEvent(trx, { workspaceId: agent.workspace_id, taskId: agent.task_id, runId: agent.run_id,
        eventKey: eventKeys.agentSettled(id, 'completed'), type: 'agent.completed', payload: { agentId: id, result } });
      await trx.updateTable('agent_instances').set({ status: 'completed', ended_at: this.now(), result_sha: result.resultSha })
        .where('id', '=', id).execute();
      return result;
    });
  }

  async fail(id: string, code: string) {
    await this.ledger.withActiveWrite(id, async (trx, agent) => {
      await trx.updateTable('agent_questions').set({ status: 'canceled', resolved_at: this.now() })
        .where('agent_instance_id', '=', id).where('status', '=', 'open').execute();
      await trx.updateTable('agent_instances').set({ status: 'failed', ended_at: this.now() }).where('id', '=', id).execute();
      await trx.updateTable('tasks').set({ status: 'incomplete', updated_at: this.now() }).where('id', '=', agent.task_id).execute();
      await appendEvent(trx, { workspaceId: agent.workspace_id, taskId: agent.task_id, runId: agent.run_id,
        eventKey: eventKeys.agentSettled(id, 'failed'), type: 'agent.failed', payload: { agentId: id, code } });
    });
  }
}
