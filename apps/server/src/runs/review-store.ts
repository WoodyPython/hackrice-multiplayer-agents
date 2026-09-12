import { ApiError, type HistoryEntry, type Review, type ReviewSource } from '@app/contracts';
import { type Db } from '../db/client.js';
import type { ApplyOperationRow, ReviewRow } from '../db/types.js';
import { toIso, toIsoOrNull } from '../http/serialize.js';

/**
 * B07: review and apply metadata (design sections 10.1, 10.3, 10.5).
 *
 * The records only. Role D builds candidates and performs the guarded ref
 * update; this stores the exact source tuple a candidate was built from, and
 * the single pending apply record that makes duplicate publication detectable.
 */

export interface ReviewStoreDeps {
  db: Db;
}

export class PgReviewStore {
  constructor(private readonly deps: ReviewStoreDeps) {}

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  /**
   * Records a review against the exact tuple it was built from (section 10.1).
   *
   * Stored in `building` because a candidate does not exist yet; the schema's
   * check permits a null candidate only in that state, so a review can never be
   * offered to an owner without one.
   */
  async create(input: {
    workspaceId: string;
    taskId: string;
    runId: string | null;
    source: ReviewSource;
  }): Promise<Review> {
    const row = await this.deps.db
      .insertInto('reviews')
      .values({
        workspace_id: input.workspaceId,
        task_id: input.taskId,
        run_id: input.runId,
        task_version: input.source.taskVersion,
        guidance_version: input.source.guidanceVersion,
        main_sha: input.source.mainSha,
        human_sha: input.source.humanSha,
        result_sha: input.source.resultSha,
        document_revisions: input.source.documentRevisions,
        context_hash: input.source.contextHash,
        status: 'building',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReview(row);
  }

  /** Attaches the candidate and offers the review for approval. */
  async markReady(reviewId: string, candidateSha: string): Promise<Review> {
    const row = await this.deps.db
      .updateTable('reviews')
      .set({ candidate_sha: candidateSha, status: 'ready', updated_at: new Date() })
      .where('id', '=', reviewId)
      .where('status', 'in', ['building', 'conflict'])
      .returningAll()
      .executeTakeFirst();
    if (!row) throw await this.explainRefusal(reviewId, 'be made ready');
    return toReview(row);
  }

  async markConflict(reviewId: string): Promise<Review> {
    const row = await this.deps.db
      .updateTable('reviews')
      .set({ status: 'conflict', updated_at: new Date() })
      .where('id', '=', reviewId)
      .where('status', 'in', ['building', 'ready'])
      .returningAll()
      .executeTakeFirst();
    if (!row) throw await this.explainRefusal(reviewId, 'be marked conflicted');
    return toReview(row);
  }

  /**
   * Invalidates every pending review for a task (section 7.6).
   *
   * "Any new accepted human edit marks it stale immediately, even before the
   * debounce has persisted the edit." Called on new edits, requirement changes,
   * and guidance changes.
   *
   * Already-applied reviews are untouched: a historical record of what was
   * published must not be rewritten by later activity.
   */
  async invalidateForTask(taskId: string, reason: string): Promise<number> {
    return this.deps.db.transaction().execute(async (db) => {
      await db.selectFrom('tasks').select('id').where('id', '=', taskId).forUpdate().executeTakeFirst();
      const rows = await db.updateTable('reviews').set({ status: 'stale', updated_at: new Date() })
        .where('task_id', '=', taskId).where('status', 'in', ['building', 'ready', 'conflict'])
        .returning('id').execute();
      void reason;
      return rows.length;
    });
  }

  /**
   * Claims a review for application.
   *
   * Section 11.2: "Review status cannot become applied from
   * stale/conflict/building." The guard is `where status = 'ready'`, which is
   * also what makes two simultaneous Apply requests resolve to one winner: the
   * loser sees no row and is told the review is no longer appliable.
   *
   * The candidate is checked here too, so a browser that was looking at an
   * earlier candidate cannot apply a refreshed one it never saw.
   */
  async claimForApply(reviewId: string, candidateSha: string): Promise<Review> {
    const row = await this.deps.db
      .selectFrom('reviews')
      .selectAll()
      .where('id', '=', reviewId)
      .where('status', '=', 'ready')
      .where('candidate_sha', '=', candidateSha)
      .executeTakeFirst();

    if (!row) {
      const current = await this.read(reviewId);
      if (!current) throw new ApiError('REVIEW_NOT_FOUND', 'No such review.');
      if (current.status !== 'ready') {
        throw new ApiError(
          'REVIEW_STALE',
          `This review is ${current.status}. Refresh it before applying.`,
          { currentStatus: current.status },
        );
      }
      throw new ApiError(
        'REVIEW_STALE',
        'The candidate changed since you loaded this review. Refresh and re-check it.',
        { currentCandidateSha: current.candidateSha },
      );
    }
    return toReview(row);
  }

  async markApplied(reviewId: string): Promise<void> {
    await this.deps.db
      .updateTable('reviews')
      .set({ status: 'applied', updated_at: new Date() })
      .where('id', '=', reviewId)
      .where('status', '=', 'ready')
      .execute();
  }

  async read(reviewId: string): Promise<Review | undefined> {
    const row = await this.deps.db
      .selectFrom('reviews')
      .selectAll()
      .where('id', '=', reviewId)
      .executeTakeFirst();
    return row ? toReview(row) : undefined;
  }

  async listForTask(taskId: string): Promise<Review[]> {
    const rows = await this.deps.db
      .selectFrom('reviews')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toReview);
  }

  // -------------------------------------------------------------------------
  // Apply operations (section 10.5)
  // -------------------------------------------------------------------------

  /**
   * Records the intent to apply, before the ref moves.
   *
   * "Git and PostgreSQL do not share a transaction." So the sequence is: write
   * this row, update the ref, then settle this row. If the process dies between
   * the second and third steps, this row is the only evidence that an apply was
   * in flight, and reconciliation compares its candidate against main.
   *
   * One row per review, enforced by a unique constraint. A second call returns
   * the existing row rather than creating a rival record, because two records
   * for one review would make reconciliation ambiguous — exactly the state
   * section 10.5 says to stop on.
   */
  async begin(input: {
    workspaceId: string;
    reviewId: string;
    expectedMainSha: string;
    candidateSha: string;
    bootId: string;
  }): Promise<{ operation: ApplyOperationRow; created: boolean }> {
    return this.deps.db.transaction().execute(async (db) => {
      const workspace = await db.selectFrom('workspaces').select('guidance_version')
        .where('id', '=', input.workspaceId).forNoKeyUpdate().executeTakeFirstOrThrow();
      const scoped = await db.selectFrom('reviews').select('task_id').where('id', '=', input.reviewId)
        .where('workspace_id', '=', input.workspaceId).executeTakeFirst();
      if (!scoped) throw new ApiError('REVIEW_NOT_FOUND');
      const task = await db.selectFrom('tasks').select(['version', 'status', 'active_run_id'])
        .where('id', '=', scoped.task_id).forUpdate().executeTakeFirstOrThrow();
      const review = await db.selectFrom('reviews').selectAll().where('id', '=', input.reviewId)
        .forUpdate().executeTakeFirstOrThrow();
      const existing = await db.selectFrom('apply_operations').selectAll().where('review_id', '=', input.reviewId).executeTakeFirst();
      if (existing) {
        if (existing.candidate_sha !== input.candidateSha || existing.expected_main_sha !== input.expectedMainSha) throw new ApiError('INPUT_CONFLICT');
        return { operation: existing, created: false };
      }
      if (review.status !== 'ready' || review.candidate_sha !== input.candidateSha || review.main_sha !== input.expectedMainSha ||
          task.active_run_id || ['completed', 'canceled'].includes(task.status) || task.version !== review.task_version ||
          workspace.guidance_version !== review.guidance_version) throw new ApiError('REVIEW_STALE');
      const pending = await db.selectFrom('apply_operations as a').innerJoin('reviews as r', 'r.id', 'a.review_id')
        .select('a.id').where('r.task_id', '=', scoped.task_id).where('a.status', 'in', ['pending', 'ambiguous']).executeTakeFirst();
      if (pending) throw new ApiError('RUN_INTERRUPTED');
      const row = await db
        .insertInto('apply_operations')
        .values({
          workspace_id: input.workspaceId,
          review_id: input.reviewId,
          expected_main_sha: input.expectedMainSha,
          candidate_sha: input.candidateSha,
          boot_id: input.bootId,
          status: 'pending',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { operation: row, created: true };
    });
  }

  async settle(
    reviewId: string,
    status: 'applied' | 'failed' | 'ambiguous',
    errorCode?: string,
  ): Promise<void> {
    await this.deps.db
      .updateTable('apply_operations')
      .set({
        status,
        error_code: errorCode ?? null,
        settled_at: new Date(),
      })
      .where('review_id', '=', reviewId)
      .where('status', '=', 'pending')
      .execute();
  }

  async readOperation(reviewId: string): Promise<ApplyOperationRow | undefined> {
    return this.deps.db
      .selectFrom('apply_operations')
      .selectAll()
      .where('review_id', '=', reviewId)
      .executeTakeFirst();
  }

  /**
   * Apply operations left pending by a previous process (section 14.4 step 4).
   *
   * Each one must be reconciled against Git main before its task becomes
   * writable again. Role D inspects main and calls `settle`: the candidate
   * already on main means it succeeded, main still at the expected value means
   * it never ran, anything else is ambiguous and stops.
   */
  /**
   * Applied changes across the workspace, newest first (section 4.1, History).
   *
   * Built on apply operations rather than on reviews: section 10.5 writes this
   * row before the ref moves and settles it afterwards, so it is the record
   * that survives a process dying mid-apply. A review alone cannot say whether
   * the commit actually reached main.
   *
   * Non-applied outcomes are included. A `failed` or `ambiguous` operation is
   * part of what happened here, and omitting it would make a stuck apply
   * invisible in the one screen meant to explain the workspace's past.
   */
  async listHistoryForWorkspace(workspaceId: string): Promise<HistoryEntry[]> {
    const rows = await this.deps.db
      .selectFrom('apply_operations')
      .innerJoin('reviews', 'reviews.id', 'apply_operations.review_id')
      .innerJoin('tasks', 'tasks.id', 'reviews.task_id')
      .select([
        'apply_operations.id as id',
        'apply_operations.review_id as review_id',
        'apply_operations.candidate_sha as candidate_sha',
        'apply_operations.status as status',
        'apply_operations.created_at as created_at',
        'apply_operations.settled_at as settled_at',
        'tasks.id as task_id',
        'tasks.title as title',
        'tasks.kind as kind',
      ])
      .where('apply_operations.workspace_id', '=', workspaceId)
      .orderBy('apply_operations.created_at', 'desc')
      .execute();

    return rows.map((row) => ({
      applyOperationId: row.id,
      reviewId: row.review_id,
      taskId: row.task_id,
      taskTitle: row.title,
      taskKind: row.kind,
      candidateSha: row.candidate_sha,
      status: row.status,
      requestedAt: row.created_at.toISOString(),
      settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    }));
  }

  async pendingFromPreviousBoots(currentBootId: string): Promise<ApplyOperationRow[]> {
    return this.deps.db
      .selectFrom('apply_operations')
      .selectAll()
      .where('status', '=', 'pending')
      .where('boot_id', '!=', currentBootId)
      .orderBy('created_at')
      .execute();
  }

  // -------------------------------------------------------------------------

  private async explainRefusal(reviewId: string, action: string): Promise<ApiError> {
    const current = await this.read(reviewId);
    if (!current) return new ApiError('REVIEW_NOT_FOUND', 'No such review.');
    return new ApiError(
      'INVALID_STATE',
      `A review that is ${current.status} cannot ${action}.`,
      { currentStatus: current.status },
    );
  }
}

// ---------------------------------------------------------------------------

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    source: {
      taskVersion: row.task_version,
      guidanceVersion: row.guidance_version,
      mainSha: row.main_sha,
      humanSha: row.human_sha,
      resultSha: row.result_sha,
      documentRevisions: row.document_revisions,
      contextHash: row.context_hash,
    },
    candidateSha: row.candidate_sha,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIsoOrNull(row.updated_at) ?? toIso(row.created_at),
  };
}
