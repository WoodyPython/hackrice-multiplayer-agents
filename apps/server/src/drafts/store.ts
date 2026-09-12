import {
  ApiError,
  type DraftFile,
  type OpenDraftResponse,
  type PersistSnapshotResult,
} from '@app/contracts';
import { isUniqueViolation, type Db } from '../db/client.js';
import type { DraftFileRow } from '../db/types.js';
import { toIso } from '../http/serialize.js';
import { assertTaskMutable, invalidateTaskReviews } from '../tasks/mutation-guard.js';

/**
 * B05: collaborative snapshot persistence (design sections 7.1 to 7.3, 11.3).
 *
 * The storage half of shared editing. Role D's room server owns the live
 * in-memory document, the update protocol, and awareness; this owns what
 * survives a restart.
 *
 * Nothing here is reachable over HTTP except opening a draft. Section 11.4:
 * "Browser clients do not directly mutate tables or storage objects." An
 * endpoint accepting a Yjs snapshot from a link holder would let anyone
 * overwrite a document wholesale, bypassing every update the room server
 * validated, so persist and initialize are in-process calls only.
 */

export interface DraftStoreDeps {
  db: Db;
}

export interface LoadedDraft {
  draftFile: DraftFile;
  /** Null until the document has been initialized (section 7.2). */
  yjsState: Uint8Array | null;
  stateVector: Uint8Array | null;
}

export class PgDraftStore {
  constructor(private readonly deps: DraftStoreDeps) {}

  async openTaskDraft(workspaceId: string, taskId: string, path: string): Promise<DraftFile> {
    return this.deps.db.transaction().execute(async (db) => {
      const task = await db.selectFrom('tasks').select(['id', 'status'])
        .where('id', '=', taskId).where('workspace_id', '=', workspaceId).forUpdate().executeTakeFirst();
      if (!task) throw new ApiError('TASK_NOT_FOUND');
      if (task.status === 'completed') throw new ApiError('DOCUMENT_EPOCH_CLOSED');
      await assertTaskMutable(db, taskId);
      const store = new PgDraftStore({ db });
      const existing = await store.findActive(taskId, path);
      const draft = await store.openForTask(workspaceId, taskId, path);
      if (!existing) await invalidateTaskReviews(db, taskId, `draft_opened:${draft.id}`);
      return draft;
    });
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  /**
   * The one active document for a task and path, creating the next epoch if
   * none is active.
   *
   * Two things make this harder than an upsert, and both have bitten:
   *
   * The epoch is computed, not fixed. Defaulting to 1 works exactly once: after
   * Apply closes an epoch (section 7.6), a new document for the same path must
   * be epoch 2, and inserting epoch 1 collides with the closed row while the
   * active-document lookup cannot see it. That is a deterministic failure on
   * the reopen path, not a race.
   *
   * Any unique violation means someone else got there first, so the handler
   * does not name a constraint. Naming one would be wrong: draft_files carries
   * two unique indexes a concurrent insert can trip — draft_files_epoch_uq on
   * (task, path, epoch) and the partial draft_files_active_uq on (task, path) —
   * and Postgres reports whichever it checks first, which is the constraint
   * declared with the table, never the partial index added later. A handler
   * naming the partial index compiles, reads correctly, and never runs.
   *
   * The retry loop closes the gap between those two: a caller that loses the
   * race may find the winner chose the same epoch it was about to, so it
   * recomputes rather than failing. Bounded, because a third attempt would mean
   * something other than contention is wrong.
   */
  async openForTask(
    workspaceId: string,
    taskId: string,
    path: string,
  ): Promise<DraftFile> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.findActive(taskId, path);
      if (existing) return toDraftFile(existing);

      const highest = await this.deps.db
        .selectFrom('draft_files')
        .select((eb) => eb.fn.max('epoch').as('epoch'))
        .where('task_id', '=', taskId)
        .where('path', '=', path)
        .executeTakeFirst();

      try {
        const row = await this.deps.db
          .insertInto('draft_files')
          .values({
            workspace_id: workspaceId,
            task_id: taskId,
            path,
            epoch: (highest?.epoch ?? 0) + 1,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toDraftFile(row);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Fall through and re-read; the next pass either finds the winner or
        // computes a fresh epoch above it.
      }
    }

    const settled = await this.findActive(taskId, path);
    if (settled) return toDraftFile(settled);
    throw new ApiError(
      'CONFLICT',
      'Could not open this document because it is being created concurrently. Try again.',
      { path },
    );
  }

  /**
   * "Edit together" (sections 2.5, 12.1).
   *
   * Finds or creates the single active manual-edit task for this file, then its
   * document. Both steps race the same way and resolve the same way: the
   * database picks a winner and the loser reads it back, so concurrent clicks
   * converge on one editing session instead of forking the draft.
   */
  async openManualEdit(
    workspaceId: string,
    input: { path: string; guestLabel: string },
  ): Promise<OpenDraftResponse> {
    const existingTask = await this.findActiveManualEditTask(workspaceId, input.path);
    if (existingTask) {
      return {
        taskId: existingTask,
        draftFile: await this.openForTask(workspaceId, existingTask, input.path),
        created: false,
      };
    }

    let taskId: string;
    let created = true;
    try {
      const task = await this.deps.db
        .insertInto('tasks')
        .values({
          workspace_id: workspaceId,
          kind: 'manual_edit',
          manual_source_path: input.path,
          creator_guest_label: input.guestLabel,
          title: input.path,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      taskId = task.id;
    } catch (error) {
      if (!isUniqueViolation(error, 'tasks_manual_active_uq')) throw error;
      const winner = await this.findActiveManualEditTask(workspaceId, input.path);
      if (!winner) throw error;
      taskId = winner;
      created = false;
    }

    return {
      taskId,
      draftFile: await this.openForTask(workspaceId, taskId, input.path),
      created,
    };
  }

  /**
   * Resolves a room to its document, or refuses.
   *
   * Section 12.1: "The same workspace/object checks apply to WebSocket room
   * resolution. A caller cannot pass an arbitrary room name that opens a
   * filesystem path." The room server calls this before attaching a socket to
   * anything, so every element of the triple is checked against the database
   * rather than trusted from the room name.
   */
  async resolveRoom(input: {
    workspaceId: string;
    taskId: string;
    draftFileId: string;
  }): Promise<DraftFile> {
    const row = await this.deps.db
      .selectFrom('draft_files')
      .selectAll()
      .where('id', '=', input.draftFileId)
      .where('task_id', '=', input.taskId)
      .where('workspace_id', '=', input.workspaceId)
      .executeTakeFirst();
    if (!row) throw new ApiError('DRAFT_NOT_FOUND', 'No such document in this task.');

    if (row.status !== 'active') {
      // Section 7.7: "If the task was completed or the epoch was closed while
      // disconnected, reject old-epoch writes."
      throw new ApiError(
        'DOCUMENT_EPOCH_CLOSED',
        'This document was closed. Open the current draft instead.',
        { draftFileId: row.id, epoch: row.epoch },
      );
    }

    return toDraftFile(row);
  }

  /**
   * Confirms a task belongs to this workspace, or reports it absent.
   *
   * Section 11.4 makes the workspace in the path the access check, and there is
   * no identity to deny, so a foreign task is NOT_FOUND and never forbidden.
   *
   * The per-task listing needs this explicitly. Its query filters on both IDs,
   * so a foreign task already returns nothing — but nothing and 200 together
   * say "this task is here and has no documents", which is a different claim
   * from "there is no such task here" and the only one of the two that is
   * false. Every sibling route answers 404; found by the B08 cross-flow check.
   */
  async requireTask(workspaceId: string, taskId: string): Promise<void> {
    const found = await this.deps.db
      .selectFrom('tasks')
      .select('id')
      .where('id', '=', taskId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!found) throw new ApiError('TASK_NOT_FOUND', 'No such task in this workspace.');
  }

  async listActiveForTask(workspaceId: string, taskId: string): Promise<DraftFile[]> {
    const rows = await this.deps.db
      .selectFrom('draft_files')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('task_id', '=', taskId)
      .where('status', '=', 'active')
      .orderBy('path')
      .execute();
    return rows.map(toDraftFile);
  }

  /**
   * Every active document in the workspace, for the Files view (section 4.1).
   *
   * The per-task listing above answers "what can I edit inside this task"; this
   * answers "what is being edited anywhere", which is what Files needs to offer
   * Edit together without first knowing which task owns the document.
   *
   * Closed epochs are excluded for the same reason they are excluded per task:
   * a closed document is not editable, and offering it would produce a
   * DOCUMENT_EPOCH_CLOSED the moment someone clicked it.
   */
  async listActiveForWorkspace(workspaceId: string): Promise<DraftFile[]> {
    const rows = await this.deps.db
      .selectFrom('draft_files')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'active')
      .orderBy('path')
      .orderBy('task_id')
      .execute();
    return rows.map(toDraftFile);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async load(workspaceId: string, draftFileId: string): Promise<LoadedDraft | null> {
    const row = await this.deps.db
      .selectFrom('draft_files')
      .selectAll()
      .where('id', '=', draftFileId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!row) return null;

    return {
      draftFile: toDraftFile(row),
      yjsState: row.yjs_state ? new Uint8Array(row.yjs_state) : null,
      stateVector: row.state_vector ? new Uint8Array(row.state_vector) : null,
    };
  }

  /**
   * Seeds a document exactly once (section 7.2).
   *
   * "Never seed the same text independently in each browser; merging separately
   * initialized copies can duplicate content." Two rooms racing to initialize
   * the same document would produce exactly that, so the write is guarded on
   * `yjs_state is null` and the loser is told to load what the winner stored.
   *
   * The initial text comes from Git, which is Role D's to read, so the caller
   * supplies both the encoded document and the blob SHA it came from.
   */
  async initialize(
    draftFileId: string,
    input: { yjsState: Uint8Array; stateVector: Uint8Array; baseBlobSha: string | null },
  ): Promise<{ initialized: boolean; draft: LoadedDraft }> {
    const updated = await this.deps.db
      .updateTable('draft_files')
      .set({
        yjs_state: Buffer.from(input.yjsState),
        state_vector: Buffer.from(input.stateVector),
        base_blob_sha: input.baseBlobSha,
        updated_at: new Date(),
      })
      .where('id', '=', draftFileId)
      .where('status', '=', 'active')
      .where('yjs_state', 'is', null)
      .returningAll()
      .executeTakeFirst();

    if (updated) {
      return {
        initialized: true,
        draft: {
          draftFile: toDraftFile(updated),
          yjsState: input.yjsState,
          stateVector: input.stateVector,
        },
      };
    }

    const current = await this.requireRow(draftFileId);
    if (current.status !== 'active') {
      throw new ApiError('DOCUMENT_EPOCH_CLOSED', 'This document was closed.');
    }
    return {
      initialized: false,
      draft: {
        draftFile: toDraftFile(current),
        yjsState: current.yjs_state ? new Uint8Array(current.yjs_state) : null,
        stateVector: current.state_vector ? new Uint8Array(current.state_vector) : null,
      },
    };
  }

  /**
   * Revision-guarded snapshot write (section 11.3).
   *
   * "Use ordered per-document saves or a revision guard so an older snapshot
   * cannot overwrite a newer one after an asynchronous write completes late."
   *
   * The guard is in the WHERE clause, not in a read-then-write: a save that
   * lost a race must be rejected by the database, because the two writes can be
   * in flight simultaneously and any check performed before the UPDATE is
   * already stale by the time it runs.
   *
   * A rejected save is normal, not an error. The caller's snapshot was simply
   * superseded by a newer one that already covers those updates.
   */
  async persist(
    draftFileId: string,
    input: { revision: number; yjsState: Uint8Array; stateVector: Uint8Array },
  ): Promise<PersistSnapshotResult> {
    const updated = await this.deps.db
      .updateTable('draft_files')
      .set({
        yjs_state: Buffer.from(input.yjsState),
        state_vector: Buffer.from(input.stateVector),
        persisted_revision: input.revision,
        updated_at: new Date(),
      })
      .where('id', '=', draftFileId)
      .where('status', '=', 'active')
      .where('persisted_revision', '<', input.revision)
      .returning('persisted_revision')
      .executeTakeFirst();

    if (updated) {
      return { applied: true, persistedRevision: updated.persisted_revision };
    }

    // Nothing was written. Two very different reasons, and the caller must be
    // able to tell them apart: a closed epoch is a hard stop, a stale revision
    // is routine.
    const current = await this.requireRow(draftFileId);
    if (current.status !== 'active') {
      throw new ApiError(
        'DOCUMENT_EPOCH_CLOSED',
        'This document was closed and no longer accepts writes.',
        { draftFileId, epoch: current.epoch },
      );
    }
    return { applied: false, persistedRevision: current.persisted_revision };
  }

  // -------------------------------------------------------------------------
  // Epochs
  // -------------------------------------------------------------------------

  /**
   * Closes a task's documents to new writes (sections 7.6, 10.5).
   *
   * Called after Apply. Section 10.5: "close the task's editing rooms in memory
   * before releasing the document gate, even if the subsequent database status
   * write fails" — so the room server's in-memory close is what stops writes
   * first, and this records it durably. Returns how many rows it closed so the
   * caller can log a reconciliation that found more or fewer than expected.
   */
  async closeEpoch(workspaceId: string, taskId: string): Promise<number> {
    const closed = await this.deps.db
      .updateTable('draft_files')
      .set({ status: 'closed', updated_at: new Date() })
      .where('workspace_id', '=', workspaceId)
      .where('task_id', '=', taskId)
      .where('status', '=', 'active')
      .returning('id')
      .execute();
    return closed.length;
  }

  /**
   * Starts a new epoch for a path whose previous document was closed.
   *
   * Section 7.6: "Do not overwrite an active Yjs document with agent output or
   * reuse its old epoch for new approved content." The closed row stays as
   * history, so a browser holding unsent edits against it can still be told
   * what happened rather than having its document silently redefined.
   *
   * Identical to openForTask by construction rather than by coincidence: both
   * mean "the active document for this path, creating the next epoch if there
   * is none". Keeping two implementations is how the reopen path came to be
   * broken in one of them, so this is a name for the call site, not a second
   * code path.
   */
  async openNextEpoch(
    workspaceId: string,
    taskId: string,
    path: string,
  ): Promise<DraftFile> {
    return this.openForTask(workspaceId, taskId, path);
  }

  // -------------------------------------------------------------------------

  private async findActive(taskId: string, path: string): Promise<DraftFileRow | undefined> {
    return this.deps.db
      .selectFrom('draft_files')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('path', '=', path)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }

  private async findActiveManualEditTask(
    workspaceId: string,
    path: string,
  ): Promise<string | undefined> {
    const row = await this.deps.db
      .selectFrom('tasks')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'manual_edit')
      .where('manual_source_path', '=', path)
      .where('status', 'not in', ['completed', 'canceled'])
      .executeTakeFirst();
    return row?.id;
  }

  private async requireRow(draftFileId: string): Promise<DraftFileRow> {
    const row = await this.deps.db
      .selectFrom('draft_files')
      .selectAll()
      .where('id', '=', draftFileId)
      .executeTakeFirst();
    if (!row) throw new ApiError('DRAFT_NOT_FOUND', 'No such document.');
    return row;
  }
}

// ---------------------------------------------------------------------------

/** Metadata only. The binary state is returned separately and never on the wire. */
function toDraftFile(row: DraftFileRow): DraftFile {
  return {
    id: row.id,
    taskId: row.task_id,
    path: row.path,
    epoch: row.epoch,
    baseBlobSha: row.base_blob_sha,
    persistedRevision: row.persisted_revision,
    status: row.status,
    updatedAt: toIso(row.updated_at),
  };
}
