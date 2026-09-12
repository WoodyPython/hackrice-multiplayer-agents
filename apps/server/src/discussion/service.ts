import type { Transaction } from 'kysely';
import {
  ApiError,
  type AgentQuestion,
  type AnswerQuestionRequest,
  type AskQuestionInput,
  type DiscussionEntry,
  type ListDiscussionQuery,
  type ListDiscussionResponse,
  type PostDiscussionRequest,
  eventKeys,
} from '@app/contracts';
import { isPgError, isUniqueViolation, type Db } from '../db/client.js';
import type { Database } from '../db/types.js';
import { appendEvent } from '../events/service.js';

/**
 * B03: task-local discussion and agent questions (sections 2.3, 2.6).
 *
 * There is no workspace-wide chat and no cross-task thread. Discussion belongs
 * to exactly one task (section 1.1).
 */

type Trx = Transaction<Database>;

export interface DiscussionServiceDeps {
  db: Db;
}

export class PgDiscussionService {
  constructor(private readonly deps: DiscussionServiceDeps) {}

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async list(
    workspaceId: string,
    taskId: string,
    query: ListDiscussionQuery,
  ): Promise<ListDiscussionResponse> {
    const task = await this.deps.db
      .selectFrom('tasks')
      .select(['id', 'discussion_seq'])
      .where('id', '=', taskId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!task) throw new ApiError('TASK_NOT_FOUND', 'No such task in this workspace.');

    const activeRun = await this.deps.db
      .selectFrom('runs')
      .select('discussion_cutoff_seq')
      .where('task_id', '=', taskId)
      .where('status', 'in', ['planning', 'working', 'needs_input'])
      .executeTakeFirst();
    const cutoff = activeRun?.discussion_cutoff_seq ?? null;

    const rows = await this.deps.db
      .selectFrom('discussion_entries')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('seq', '>', query.afterSeq)
      .orderBy('seq')
      .limit(query.limit)
      .execute();

    const entryIds = rows.map((r) => r.id);
    const [materials, questions] = await Promise.all([
      entryIds.length
        ? this.deps.db
            .selectFrom('material_links')
            .select(['discussion_entry_id', 'material_id'])
            .where('discussion_entry_id', 'in', entryIds)
            .execute()
        : Promise.resolve([]),
      entryIds.length
        ? this.deps.db
            .selectFrom('agent_questions')
            .select(['id', 'status', 'question_entry_id', 'answer_entry_id'])
            .where((eb) =>
              eb.or([
                eb('question_entry_id', 'in', entryIds),
                eb('answer_entry_id', 'in', entryIds),
              ]),
            )
            .execute()
        : Promise.resolve([]),
    ]);

    const byEntry = new Map<string, string[]>();
    for (const link of materials) {
      if (!link.discussion_entry_id) continue;
      const list = byEntry.get(link.discussion_entry_id) ?? [];
      list.push(link.material_id);
      byEntry.set(link.discussion_entry_id, list);
    }

    const questionByEntry = new Map<string, DiscussionEntry['question']>();
    for (const q of questions) {
      questionByEntry.set(q.question_entry_id, {
        id: q.id,
        status: q.status,
        role: 'asked',
      });
      if (q.answer_entry_id) {
        questionByEntry.set(q.answer_entry_id, {
          id: q.id,
          status: q.status,
          role: 'answer',
        });
      }
    }

    return {
      entries: rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        seq: row.seq,
        actorType: row.actor_type,
        guestLabel: row.guest_label,
        body: row.body,
        createdAt: toIso(row.created_at),
        materialIds: byEntry.get(row.id) ?? [],
        question: questionByEntry.get(row.id) ?? null,
        // Section 2.3: the interface labels these "Added after this run started".
        afterActiveRunCutoff: cutoff !== null && row.seq > cutoff,
      })),
      latestSeq: task.discussion_seq,
      activeRunCutoffSeq: cutoff,
    };
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  async post(
    workspaceId: string,
    taskId: string,
    input: PostDiscussionRequest,
  ): Promise<DiscussionEntry> {
    return this.deps.db.transaction().execute(async (trx) => {
      if (input.clientRequestId) {
        const existing = await trx
          .selectFrom('discussion_entries')
          .select('id')
          .where('task_id', '=', taskId)
          .where('client_request_id', '=', input.clientRequestId)
          .executeTakeFirst();
        if (existing) return this.loadEntry(trx, taskId, existing.id);
      }

      const entryId = await this.insertEntry(trx, workspaceId, taskId, {
        actorType: 'guest',
        guestLabel: input.guestLabel,
        body: input.body,
        clientRequestId: input.clientRequestId ?? null,
      });

      if (input.materialIds.length > 0) {
        await this.attachMaterials(trx, workspaceId, taskId, entryId, input.materialIds);
      }

      return this.loadEntry(trx, taskId, entryId);
    });
  }

  // -------------------------------------------------------------------------
  // Agent questions (section 2.6)
  // -------------------------------------------------------------------------

  /**
   * Records a question and renders it as a discussion entry.
   *
   * Called by Role C's worker tool layer, not by a browser. `expiresAt` is the
   * asking agent's existing deadline: section 9.2 is explicit that waiting for
   * a human consumes that clock and asking never extends it.
   */
  async ask(
    workspaceId: string,
    taskId: string,
    input: AskQuestionInput,
  ): Promise<AgentQuestion> {
    return this.deps.db.transaction().execute(async (trx) => {
      const agent = await trx
        .selectFrom('agent_instances')
        .select(['id', 'run_id', 'deadline_at', 'status'])
        .where('id', '=', input.agentInstanceId)
        .where('task_id', '=', taskId)
        .executeTakeFirst();
      if (!agent) throw new ApiError('QUESTION_NOT_FOUND', 'No such agent instance.');

      if (!agent.deadline_at) {
        throw new ApiError(
          'INVALID_STATE',
          'An agent that has not started cannot ask a question.',
        );
      }

      const entryId = await this.insertEntry(trx, workspaceId, taskId, {
        actorType: 'agent',
        guestLabel: null,
        body: input.body,
        clientRequestId: null,
      });

      let question;
      try {
        question = await trx
          .insertInto('agent_questions')
          .values({
            workspace_id: workspaceId,
            task_id: taskId,
            run_id: agent.run_id,
            agent_instance_id: agent.id,
            question_entry_id: entryId,
            expires_at: agent.deadline_at,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error, 'agent_questions_one_open_uq')) {
          throw new ApiError(
            'INVALID_STATE',
            'This agent already has an open question.',
          );
        }
        throw error;
      }

      await trx
        .updateTable('tasks')
        .set({ status: 'needs_input', updated_at: new Date() })
        .where('id', '=', taskId)
        .execute();
      await trx
        .updateTable('runs')
        .set({ status: 'needs_input' })
        .where('id', '=', agent.run_id)
        .execute();

      await appendEvent(trx, {
        workspaceId,
        taskId,
        runId: agent.run_id,
        eventKey: eventKeys.agentWaiting(question.id),
        type: 'agent.waiting',
        payload: { questionId: question.id },
      });

      return toQuestion(question);
    });
  }

  /**
   * Answers an open question (section 2.6).
   *
   * The answer is above the run's discussion cutoff and still reaches the
   * waiting agent: it is a reply to a question the run itself asked, routed
   * through the question record rather than through discussion context.
   */
  async answer(
    workspaceId: string,
    taskId: string,
    input: AnswerQuestionRequest,
  ): Promise<{ question: AgentQuestion; answerEntry: DiscussionEntry }> {
    return this.deps.db.transaction().execute(async (trx) => {
      const question = await trx
        .selectFrom('agent_questions')
        .selectAll()
        .where('id', '=', input.questionId)
        .where('task_id', '=', taskId)
        .where('workspace_id', '=', workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!question) throw new ApiError('QUESTION_NOT_FOUND', 'No such question.');

      if (question.status !== 'open') {
        throw new ApiError(
          'QUESTION_NOT_OPEN',
          `This question is already ${question.status}.`,
          { status: question.status },
        );
      }

      /*
       * Role C owns deadline enforcement, so there is a window where a question
       * is past its expiry but still marked open because the sweep has not run.
       * Accepting an answer there would record it under a "sent" indication
       * while no agent will ever read it. Treat the timestamp as authoritative
       * and resolve the row here, so the state repairs itself.
       */
      const now = new Date();
      if (new Date(question.expires_at).getTime() <= now.getTime()) {
        await trx
          .updateTable('agent_questions')
          .set({ status: 'expired', resolved_at: now })
          .where('id', '=', question.id)
          .execute();
        await this.settleTaskIfNoOpenQuestions(trx, taskId, question.run_id);
        throw new ApiError(
          'AGENT_TIMED_OUT',
          'The agent that asked this ran out of time. Retry the task to ask again.',
        );
      }

      if (input.clientRequestId) {
        const existing = await trx
          .selectFrom('discussion_entries')
          .select('id')
          .where('task_id', '=', taskId)
          .where('client_request_id', '=', input.clientRequestId)
          .executeTakeFirst();
        if (existing) {
          return {
            question: toQuestion(question),
            answerEntry: await this.loadEntry(trx, taskId, existing.id),
          };
        }
      }

      const answerEntryId = await this.insertEntry(trx, workspaceId, taskId, {
        actorType: 'guest',
        guestLabel: input.guestLabel,
        body: input.body,
        clientRequestId: input.clientRequestId ?? null,
      });

      const updated = await trx
        .updateTable('agent_questions')
        .set({ status: 'answered', answer_entry_id: answerEntryId, resolved_at: now })
        .where('id', '=', question.id)
        .where('status', '=', 'open')
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.settleTaskIfNoOpenQuestions(trx, taskId, question.run_id);

      await appendEvent(trx, {
        workspaceId,
        taskId,
        runId: question.run_id,
        eventKey: eventKeys.questionAnswered(question.id),
        type: 'agent.question_answered',
        payload: { questionId: question.id },
      });

      return {
        question: toQuestion(updated),
        answerEntry: await this.loadEntry(trx, taskId, answerEntryId),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Allocates the next sequence and inserts.
   *
   * The UPDATE ... RETURNING takes the task row lock, so sequence allocation is
   * serialized and sequence order equals commit order. That is precisely what
   * makes a run's discussion cutoff exact rather than approximate: with a plain
   * counter or a timestamp, an entry could commit after a later-numbered one
   * and fall silently outside the run it belonged in.
   */
  private async insertEntry(
    trx: Trx,
    workspaceId: string,
    taskId: string,
    entry: {
      actorType: 'guest' | 'agent' | 'system';
      guestLabel: string | null;
      body: string;
      clientRequestId: string | null;
    },
  ): Promise<string> {
    const allocated = await trx
      .updateTable('tasks')
      .set((eb) => ({ discussion_seq: eb('discussion_seq', '+', 1) }))
      .where('id', '=', taskId)
      .where('workspace_id', '=', workspaceId)
      .returning('discussion_seq')
      .executeTakeFirst();
    if (!allocated) throw new ApiError('TASK_NOT_FOUND', 'No such task in this workspace.');

    const row = await trx
      .insertInto('discussion_entries')
      .values({
        workspace_id: workspaceId,
        task_id: taskId,
        seq: allocated.discussion_seq,
        actor_type: entry.actorType,
        guest_label: entry.guestLabel,
        body: entry.body,
        client_request_id: entry.clientRequestId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  private async attachMaterials(
    trx: Trx,
    workspaceId: string,
    taskId: string,
    entryId: string,
    materialIds: string[],
  ): Promise<void> {
    try {
      await trx
        .insertInto('material_links')
        .values(
          materialIds.map((materialId) => ({
            workspace_id: workspaceId,
            material_id: materialId,
            task_id: taskId,
            discussion_entry_id: entryId,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    } catch (error) {
      if (isPgError(error) && error.code === '23503') {
        throw new ApiError(
          'MATERIAL_NOT_FOUND',
          'An attached material does not belong to this workspace.',
        );
      }
      throw error;
    }
  }

  /**
   * Leaves needs_input once nothing is open.
   *
   * Section 2.6 derives the task state from question records rather than
   * setting it independently, so a task cannot sit in needs_input with nothing
   * to answer.
   */
  private async settleTaskIfNoOpenQuestions(
    trx: Trx,
    taskId: string,
    runId: string,
  ): Promise<void> {
    const open = await trx
      .selectFrom('agent_questions')
      .select('id')
      .where('run_id', '=', runId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (open) return;

    await trx
      .updateTable('tasks')
      .set({ status: 'working', updated_at: new Date() })
      .where('id', '=', taskId)
      .where('status', '=', 'needs_input')
      .execute();
    await trx
      .updateTable('runs')
      .set({ status: 'working' })
      .where('id', '=', runId)
      .where('status', '=', 'needs_input')
      .execute();
  }

  private async loadEntry(
    db: Db | Trx,
    taskId: string,
    entryId: string,
  ): Promise<DiscussionEntry> {
    const row = await db
      .selectFrom('discussion_entries')
      .selectAll()
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();

    const [materials, question, activeRun] = await Promise.all([
      db
        .selectFrom('material_links')
        .select('material_id')
        .where('discussion_entry_id', '=', entryId)
        .execute(),
      db
        .selectFrom('agent_questions')
        .select(['id', 'status', 'question_entry_id', 'answer_entry_id'])
        .where((eb) =>
          eb.or([eb('question_entry_id', '=', entryId), eb('answer_entry_id', '=', entryId)]),
        )
        .executeTakeFirst(),
      db
        .selectFrom('runs')
        .select('discussion_cutoff_seq')
        .where('task_id', '=', taskId)
        .where('status', 'in', ['planning', 'working', 'needs_input'])
        .executeTakeFirst(),
    ]);

    return {
      id: row.id,
      taskId: row.task_id,
      seq: row.seq,
      actorType: row.actor_type,
      guestLabel: row.guest_label,
      body: row.body,
      createdAt: toIso(row.created_at),
      materialIds: materials.map((m) => m.material_id),
      question: question
        ? {
            id: question.id,
            status: question.status,
            role: question.question_entry_id === entryId ? 'asked' : 'answer',
          }
        : null,
      afterActiveRunCutoff:
        activeRun !== undefined && row.seq > activeRun.discussion_cutoff_seq,
    };
  }
}

// ---------------------------------------------------------------------------

function toQuestion(row: {
  id: string;
  task_id: string;
  run_id: string;
  agent_instance_id: string;
  question_entry_id: string;
  answer_entry_id: string | null;
  status: AgentQuestion['status'];
  asked_at: Date | string;
  expires_at: Date | string;
  resolved_at: Date | string | null;
}): AgentQuestion {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    agentInstanceId: row.agent_instance_id,
    questionEntryId: row.question_entry_id,
    answerEntryId: row.answer_entry_id,
    status: row.status,
    askedAt: toIso(row.asked_at),
    expiresAt: toIso(row.expires_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
