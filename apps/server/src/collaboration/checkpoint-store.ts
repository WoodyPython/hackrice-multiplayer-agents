import { ApiError, eventKeys, type DraftCapture } from '@app/contracts';
import type { Db } from '../db/client.js';
import { appendEvent } from '../events/service.js';

/** D04's persistence seam; Git success precedes this short database transaction. */
export class PgCheckpointStore {
  constructor(private readonly db: Db) {}

  async requireTask(workspaceId: string, taskId: string): Promise<void> {
    const task = await this.db.selectFrom('tasks').select('status')
      .where('workspace_id', '=', workspaceId).where('id', '=', taskId).executeTakeFirst();
    if (!task) throw new ApiError('TASK_NOT_FOUND');
    if ((task.status === 'completed' || task.status === 'awaiting_confirmation')) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
  }

  async record(workspaceId: string, capture: DraftCapture): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const task = await trx.selectFrom('tasks').select('status')
        .where('workspace_id', '=', workspaceId).where('id', '=', capture.taskId)
        .forUpdate().executeTakeFirst();
      if (!task) throw new ApiError('TASK_NOT_FOUND');
      if ((task.status === 'completed' || task.status === 'awaiting_confirmation')) throw new ApiError('DOCUMENT_EPOCH_CLOSED');
      const drafts = await trx.selectFrom('draft_files').select(['id', 'status', 'persisted_revision'])
        .where('workspace_id', '=', workspaceId).where('task_id', '=', capture.taskId)
        .forShare().execute();
      for (const [id, revision] of Object.entries(capture.documentRevisions)) {
        const draft = drafts.find((row) => row.id === id);
        if (!draft || draft.status !== 'active') throw new ApiError('DOCUMENT_EPOCH_CLOSED');
        if (draft.persisted_revision !== revision) throw new ApiError('DRAFT_NOT_SAVED');
      }
      if (drafts.filter((row) => row.status === 'active').length !== Object.keys(capture.documentRevisions).length) {
        throw new ApiError('DRAFT_NOT_SAVED', 'The set of draft documents changed. Retry capture.');
      }
      const checkpoint = await trx.insertInto('draft_checkpoints').values({
        workspace_id: workspaceId, task_id: capture.taskId, commit_sha: capture.checkpointSha,
        document_revisions: capture.documentRevisions,
      }).returning('id').executeTakeFirstOrThrow();
      await appendEvent(trx, {
        workspaceId, taskId: capture.taskId, type: 'draft.checkpointed',
        eventKey: eventKeys.draftCheckpointed(checkpoint.id),
        payload: { checkpointId: checkpoint.id, commitSha: capture.checkpointSha,
          documentRevisions: capture.documentRevisions, contextHash: capture.contextHash },
      });
    });
  }
}
