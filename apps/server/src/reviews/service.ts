import { createHash } from 'node:crypto';
import {
  ApiError, contextManifestSchema, currentReview, eventKeys, reviewDetailSchema, reviewSourceSchema, resolveCandidateRequestSchema,
  uuidSchema, type CollaborationService, type Review, type ReviewCandidateData, type ResolveCandidateRequest,
  type ReviewService, type ReviewDetail,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { ApplyOperationRow } from '../db/types.js';
import { appendEvent } from '../events/service.js';
import { LocalGitService } from '../git/service.js';
import { PgReviewStore } from '../runs/review-store.js';
import { TaskDocumentGate } from '../collaboration/gate.js';
import { filePath } from '../git/files.js';
import { LiveDocumentCoordinator } from '../collaboration/coordinator.js';
import { applyReviewRequestSchema } from '@app/contracts';
import { invalidateTaskReviews } from '../tasks/mutation-guard.js';

/** Stable context digest; D04's digest alone only identifies the captured draft. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

export class LocalReviewService implements Pick<ReviewService, 'prepare' | 'resolve' | 'invalidate' | 'apply'> {
  private readonly store: PgReviewStore;
  // Serializes prepare/resolve for a task; never acquired from inside a Git/document gate.
  private readonly operations = new TaskDocumentGate();
  constructor(private readonly deps: { db: Db; git: LocalGitService; collaboration: Pick<CollaborationService, 'capture'>; bootId?: string }) {
    this.store = new PgReviewStore({ db: deps.db });
  }

  /** Startup only: reconcile durable publication intent before accepting actions.
   * Never publishes Git or grants authority to resume an old attempt.
   */
  async reconcilePreviousApplies() {
    const collaboration = this.deps.collaboration;
    if (!(collaboration instanceof LiveDocumentCoordinator) || !this.deps.bootId) throw new ApiError('INVALID_STATE');
    const counts = { applied: 0, pending: 0, ambiguous: 0 };
    for (const operation of await this.store.pendingFromPreviousBoots(this.deps.bootId)) {
      const review = await this.scoped(operation.workspace_id, operation.review_id);
      await this.operations.run(review.taskId, () => this.deps.git.withApply(operation.workspace_id, (git) =>
        collaboration.withApply(review.taskId, async (live) => {
          if (operation.candidate_sha !== review.candidateSha || operation.expected_main_sha !== review.source.mainSha) {
            throw new ApiError('INPUT_CONFLICT');
          }
          const head = await git.main();
          if (head === operation.candidate_sha) {
            const artifact = await git.readReview(review.id, operation.candidate_sha);
            if (canonical(artifact.source) !== canonical(review.source) || digest(artifact.context) !== review.source.contextHash || artifact.conflicts.length) {
              throw new ApiError('INPUT_CONFLICT');
            }
            live.close();
            const compatible = await this.deps.db.transaction().execute(async (db) => {
              await db.selectFrom('workspaces').select('id').where('id', '=', operation.workspace_id).forNoKeyUpdate().executeTakeFirstOrThrow();
              await db.selectFrom('tasks').select('id').where('id', '=', review.taskId).forUpdate().executeTakeFirstOrThrow();
              const locked = await db.selectFrom('reviews').select('status').where('id', '=', review.id).forUpdate().executeTakeFirstOrThrow();
              if (!['ready', 'applied'].includes(locked.status) || !await this.publishedStateMatches(db, review, operation, artifact.context)) {
                await db.updateTable('apply_operations').set({ status: 'ambiguous', error_code: 'RUN_INTERRUPTED', settled_at: new Date() })
                  .where('id', '=', operation.id).execute();
                return false;
              }
              await this.finalizeApplied(db, review, operation);
              return true;
            });
            if (compatible) counts.applied++; else counts.ambiguous++;
          } else if (head === operation.expected_main_sha) {
            counts.pending++;
          } else {
            await this.store.settle(review.id, 'ambiguous', 'RUN_INTERRUPTED');
            // The durable guard blocks this task without claiming it was applied.
            counts.ambiguous++;
          }
        })));
    }
    return counts;
  }

  /** Publication proves Git changed, not that newer task state may be erased. */
  private async publishedStateMatches(db: Db, review: Review, operation: ApplyOperationRow, context: Record<string, unknown>) {
    const task = await db.selectFrom('tasks').select(['version', 'status', 'active_run_id']).where('id', '=', review.taskId).executeTakeFirstOrThrow();
    if (task.version !== review.source.taskVersion || task.active_run_id || task.status === 'canceled') return false;
    const newerRun = await db.selectFrom('runs').select('id').where('task_id', '=', review.taskId)
      .where('created_at', '>', operation.created_at).executeTakeFirst();
    if (newerRun) return false;
    if (task.status === 'completed' || task.status === 'awaiting_confirmation') return review.status === 'applied';
    try {
      const current = await this.inputs(operation.workspace_id, review.taskId, db);
      return current.run?.id === (review.runId ?? undefined) && digest({ ...current.context, draft: context.draft }) === review.source.contextHash;
    } catch (error) {
      if (error instanceof ApiError && ['INVALID_STATE', 'INPUT_CONFLICT'].includes(error.code)) return false;
      throw error;
    }
  }

  private async finalizeApplied(db: Db, review: Review, operation: ApplyOperationRow) {
    const now = new Date();
    await db.updateTable('apply_operations').set({ status: 'applied', settled_at: now, error_code: null }).where('id', '=', operation.id).execute();
    await db.updateTable('reviews').set({ status: 'applied', updated_at: now }).where('id', '=', review.id).where('status', '=', 'ready').execute();
    await db.updateTable('tasks').set({ status: 'awaiting_confirmation', active_run_id: null, updated_at: now }).where('id', '=', review.taskId).execute();
    await db.updateTable('draft_files').set({ status: 'closed', updated_at: now }).where('task_id', '=', review.taskId).where('status', '=', 'active').execute();
    await appendEvent(db, { workspaceId: operation.workspace_id, taskId: review.taskId, runId: review.runId,
      type: 'task.applied', eventKey: eventKeys.taskApplied(operation.id),
      payload: { applyOperationId: operation.id, reviewId: review.id, appliedCommitSha: operation.candidate_sha } });
  }

  private async inputs(workspaceId: string, taskId: string, transaction?: Db) {
    // A short consistent DB snapshot. Never hold it during Git or document capture.
    const read = async (db: Db) => {
      const workspace = await db.selectFrom('workspaces').select(['id', 'guidance', 'guidance_version'])
        .where('id', '=', workspaceId).executeTakeFirst();
      if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');
      const task = await db.selectFrom('tasks').selectAll().where('workspace_id', '=', workspaceId)
        .where('id', '=', taskId).executeTakeFirst();
      if (!task) throw new ApiError('TASK_NOT_FOUND', 'No such task in this workspace.');
      if (task.active_run_id || ['completed', 'awaiting_confirmation', 'canceled'].includes(task.status) ||
        (task.kind === 'manual_edit' && ['planning', 'working', 'needs_input'].includes(task.status))) {
        throw new ApiError('INVALID_STATE', 'Finish the current task execution before requesting review.');
      }
      const run = task.kind === 'manual_edit' ? undefined : await db.selectFrom('runs').selectAll()
        .where('task_id', '=', taskId).where('workspace_id', '=', workspaceId).orderBy('attempt', 'desc').executeTakeFirst();
      if (task.kind !== 'manual_edit' && (!run || run.status !== 'completed' || !run.result_head_sha || !run.input_snapshot_sha || !run.context_manifest)) {
        throw new ApiError('INVALID_STATE', 'This task needs a completed integrated agent result before review.');
      }
      if (run) {
        const unfinished = await db.selectFrom('agent_instances').select('id').where('run_id', '=', run.id)
          .where('status', '!=', 'completed').executeTakeFirst();
        if (unfinished) throw new ApiError('INVALID_STATE', 'Required assignments have not all completed.');
      }
      const inputs = await db.selectFrom('task_input_links').select(['material_id', 'draft_file_id', 'approved_path', 'source_version'])
        .where('task_id', '=', taskId).where('workspace_id', '=', workspaceId).execute();
      const links = await db.selectFrom('material_links').innerJoin('materials', 'materials.id', 'material_links.material_id')
        .select(['materials.id', 'materials.sha256']).where('material_links.workspace_id', '=', workspaceId)
        .where('material_links.task_id', '=', taskId).where('materials.deleted_at', 'is', null).execute();
      const selectedIds = inputs.flatMap((i) => i.material_id ? [i.material_id] : []);
      const selected = selectedIds.length ? await db.selectFrom('materials').select(['id', 'sha256'])
        .where('workspace_id', '=', workspaceId).where('id', 'in', selectedIds).where('deleted_at', 'is', null).execute() : [];
      if (selected.length !== new Set(selectedIds).size) throw new ApiError('INPUT_CONFLICT', 'A selected material is unavailable.');
      const materials = [...new Map([...links, ...selected].map((m) => [m.id, { materialId: m.id, sha256: m.sha256.toString('hex') }])).values()]
        .sort((a, b) => a.materialId < b.materialId ? -1 : 1);
      const context = {
        task: { id: task.id, kind: task.kind, version: task.version, title: task.title, outcome: task.outcome,
          criteria: task.criteria, outputPaths: task.output_paths },
        guidance: { version: workspace.guidance_version, text: workspace.guidance },
        inputs: inputs.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0), materials,
        run: run ? { id: run.id, taskVersion: run.task_version, guidanceVersion: run.guidance_version,
          inputSnapshotSha: run.input_snapshot_sha, resultSha: run.result_head_sha,
          manifest: contextManifestSchema.parse(run.context_manifest) } : null,
      };
      return { task, workspace, run, context };
    };
    return transaction ? read(transaction) : this.deps.db.transaction().setIsolationLevel('repeatable read').execute(read);
  }

  async invalidate(input: { taskId: string; reason: string }): Promise<void> {
    await this.deps.db.transaction().execute(async (db) => {
      await db.selectFrom('tasks').select('id').where('id', '=', input.taskId).forUpdate().executeTakeFirstOrThrow();
      await invalidateTaskReviews(db, input.taskId, input.reason);
    });
  }

  /**
   * Apply is open to any holder of the workspace link, not only the owner.
   *
   * This is a deliberate departure from design section 10.3 ("Apply takes a
   * review ID and the browser-held owner key"), made because owner-only apply
   * blocked the collaboration the product is for. It is recorded here rather
   * than only in the changelog because the removed lines were a permission
   * check, and a future reader should find the reason at the site.
   *
   * What it costs, stated plainly: the workspace URL is now sufficient to
   * publish to approved main. Section 1.2 already says the contribution URL is
   * link access rather than identity, so this widens what link access permits
   * rather than inventing a new trust level. What it does NOT do is accept a
   * claimed identity: section 1.3 forbids treating a guest label as authority,
   * and no caller-supplied "I am involved in this task" flag is consulted —
   * there is nothing to verify it against. Either the link is enough or the
   * owner key is; a self-asserted middle ground would only look like security.
   *
   * Every other owner-gated operation is untouched: workspace settings and
   * guidance still require the key.
   */
  async apply(input: { workspaceId: string; reviewId: string; candidateSha: string }) {
    const workspaceId = uuidSchema.parse(input.workspaceId).toLowerCase(), reviewId = uuidSchema.parse(input.reviewId).toLowerCase();
    const { candidateSha } = applyReviewRequestSchema.parse({ candidateSha: input.candidateSha });
    const workspace = await this.deps.db.selectFrom('workspaces').select('id').where('id', '=', workspaceId).executeTakeFirst();
    if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND');
    const found = await this.scoped(workspaceId, reviewId);
    const collaboration = this.deps.collaboration;
    if (!(collaboration instanceof LiveDocumentCoordinator) || !this.deps.bootId) throw new ApiError('INVALID_STATE', 'Apply is not configured.');
    return this.operations.run(found.taskId, () => this.deps.git.withApply(workspaceId, (git) => collaboration.withApply(found.taskId, async (live) => {
      const review = await this.scoped(workspaceId, reviewId);
      if (review.candidateSha !== candidateSha) throw new ApiError('REVIEW_STALE', 'The candidate changed. Refresh review.');
      const artifact = await git.readReview(reviewId, candidateSha);
      if (canonical(artifact.source) !== canonical(review.source) || digest(artifact.context) !== review.source.contextHash) throw new ApiError('INPUT_CONFLICT');
      if (artifact.conflicts.length) throw new ApiError('REVIEW_CONFLICT');
      let operation = await this.store.readOperation(reviewId);
      if (operation && (operation.workspace_id !== workspaceId || operation.candidate_sha !== candidateSha || operation.expected_main_sha !== review.source.mainSha)) throw new ApiError('INPUT_CONFLICT');
      const head = await git.main();
      if (operation?.status === 'applied' && review.status === 'applied') {
        live.close();
        return { status: 'applied' as const, appliedCommitSha: candidateSha, alreadyApplied: true };
      }
      if (operation && ['failed', 'ambiguous'].includes(operation.status)) throw new ApiError('RUN_INTERRUPTED', 'This apply operation needs review.');
      if (operation && head !== candidateSha && head !== operation.expected_main_sha) {
        await this.store.settle(reviewId, 'ambiguous', 'RUN_INTERRUPTED');
        live.close();
        throw new ApiError('RUN_INTERRUPTED', 'The apply outcome is ambiguous.');
      }
      const alreadyApplied = !!operation && head === candidateSha;
      if (!alreadyApplied) {
        await this.store.claimForApply(reviewId, candidateSha);
        if (head !== review.source.mainSha || !await live.isCurrent(review.source.documentRevisions)) {
          await this.invalidate({ taskId: review.taskId, reason: 'apply:freshness' });
          throw new ApiError('REVIEW_STALE');
        }
        const started = await this.store.begin({ workspaceId, reviewId, candidateSha, expectedMainSha: review.source.mainSha, bootId: this.deps.bootId! });
        operation = started.operation;
      }
      if (!operation) throw new ApiError('INVALID_STATE');
      if (alreadyApplied) live.close();
      // The pending row is committed first. Only final validation + the single ref update
      // run under DB row locks, preventing requirements/Start/guidance races.
      try { await this.deps.db.transaction().execute(async (db) => {
        // Still locked, for ordering against guidance/Start writers. The owner
        // re-check that used to read this row is gone with the gate above.
        await db.selectFrom('workspaces').select('id').where('id', '=', workspaceId).forNoKeyUpdate().executeTakeFirstOrThrow();
        await db.selectFrom('tasks').selectAll().where('id', '=', review.taskId).forUpdate().executeTakeFirstOrThrow();
        const lockedReview = await db.selectFrom('reviews').selectAll().where('id', '=', reviewId).forUpdate().executeTakeFirstOrThrow();
        if (alreadyApplied && (!['ready', 'applied'].includes(lockedReview.status) ||
            !await this.publishedStateMatches(db, review, operation!, artifact.context))) throw new ApiError('RUN_INTERRUPTED', 'Published review metadata requires reconciliation.');
        if (!alreadyApplied) {
          if (lockedReview.status !== 'ready' || lockedReview.candidate_sha !== candidateSha) throw new ApiError('REVIEW_STALE');
          await db.selectFrom('draft_files').select('id').where('task_id', '=', review.taskId).forUpdate().execute();
          await db.selectFrom('runs').select('id').where('task_id', '=', review.taskId).forUpdate().execute();
          await db.selectFrom('agent_instances').select('id').where('task_id', '=', review.taskId).forUpdate().execute();
          await db.selectFrom('task_input_links').select('id').where('task_id', '=', review.taskId).forUpdate().execute();
          await db.selectFrom('material_links').select('id').where('task_id', '=', review.taskId).forUpdate().execute();
          await db.selectFrom('materials').select('id').where('workspace_id', '=', workspaceId).forShare().execute();
          const current = await this.inputs(workspaceId, review.taskId, db);
          if (digest({ ...current.context, draft: artifact.context.draft }) !== review.source.contextHash || current.run?.id !== (review.runId ?? undefined)) throw new ApiError('REVIEW_STALE');
          if (await git.ref(`refs/heads/human/${review.taskId}`) !== review.source.humanSha) throw new ApiError('REVIEW_STALE');
          if (!await git.isAncestor(await git.ref(`refs/app/bases/human/${review.taskId}`), review.source.humanSha)) throw new ApiError('INPUT_CONFLICT');
          if (current.run && (await git.ref(`refs/heads/results/${current.run.id}`) !== review.source.resultSha ||
            await git.ref(`refs/app/bases/results/${current.run.id}`) !== current.run.input_snapshot_sha)) throw new ApiError('REVIEW_STALE');
          if (!await live.isCurrent(review.source.documentRevisions)) throw new ApiError('REVIEW_STALE');
          const result = await git.publish(review.source.mainSha, candidateSha);
          if (!result.applied) throw new ApiError('REVIEW_STALE');
          live.close();
        }
        await this.finalizeApplied(db, review, operation!);
      }); } catch (error) {
        // A failed SQL commit does not roll Git back. Leave its receipt pending and
        // keep rooms closed if publication happened; the next authorized Apply reconciles it.
        const currentMain = await git.main().catch((failure: unknown) => { live.close(); throw failure; });
        if (currentMain === candidateSha) {
          live.close();
          if (alreadyApplied && error instanceof ApiError && error.code === 'RUN_INTERRUPTED') await this.store.settle(reviewId, 'ambiguous', 'RUN_INTERRUPTED');
        }
        else if (currentMain !== review.source.mainSha) {
          live.close();
          await this.store.settle(reviewId, 'ambiguous', 'RUN_INTERRUPTED');
        } else if (error instanceof ApiError && ['REVIEW_STALE', 'INPUT_CONFLICT', 'INVALID_STATE'].includes(error.code)) {
          await this.store.settle(reviewId, 'failed', 'REVIEW_STALE');
          await this.invalidate({ taskId: review.taskId, reason: 'apply:source_changed' });
          throw new ApiError('REVIEW_STALE', 'The review sources changed. Request review again.');
        }
        throw error;
      }
      return { status: 'applied' as const, appliedCommitSha: candidateSha, alreadyApplied };
    })));
  }

  prepare(input: Parameters<ReviewService['prepare']>[0]): Promise<Review>;
  prepare(workspaceId: string, taskId: string): Promise<ReviewDetail>;
  async prepare(input: string | Parameters<ReviewService['prepare']>[0], task?: string): Promise<Review | ReviewDetail> {
    if (typeof input !== 'string') return (await this.prepare(input.workspaceId, input.taskId)).review;
    let workspaceId = input, taskId = task!;
    workspaceId = uuidSchema.parse(workspaceId).toLowerCase(); taskId = uuidSchema.parse(taskId).toLowerCase();
    return this.operations.run(taskId, async () => {
      // Automatic clients can arrive together. Reuse the current candidate so
      // opening the Changes tab in several browsers never creates duplicates.
      const existing = currentReview(await this.store.listForTask(taskId));
      if (existing && ["ready", "conflict"].includes(existing.status))
        return this.read(workspaceId, existing.id);
      const initial = await this.inputs(workspaceId, taskId);
      const capture = await this.deps.collaboration.capture({ workspaceId, taskId });
      const current = await this.inputs(workspaceId, taskId);
      if (digest(initial.context) !== digest(current.context)) throw new ApiError('INPUT_CONFLICT', 'Review inputs changed during capture. Request review again.');
      const refs = await this.deps.git.reviewSources({ workspaceId, taskId, humanSha: capture.checkpointSha,
        ...(current.run ? { run: { id: current.run.id, resultSha: current.run.result_head_sha!, inputSnapshotSha: current.run.input_snapshot_sha! } } : {}) });
      const context = { ...current.context, draft: capture };
      const source = reviewSourceSchema.parse({ taskVersion: current.task.version, guidanceVersion: current.workspace.guidance_version,
        ...refs, humanSha: capture.checkpointSha, documentRevisions: capture.documentRevisions, contextHash: digest(context) });
      const review = await this.store.create({ workspaceId, taskId, runId: current.run?.id ?? null, source });
      const built = await this.deps.git.buildReview({ workspaceId, taskId, reviewId: review.id, source, context });
      // D07 owns ongoing invalidation. D06 must still bind construction to the metadata it actually read.
      const final = await this.inputs(workspaceId, taskId);
      if (digest(final.context) !== digest(current.context)) throw new ApiError('INPUT_CONFLICT', 'Review inputs changed while building. Request review again.');
      return this.finish(workspaceId, review, built.data, null);
    });
  }

  private async scoped(workspaceId: string, reviewId: string) {
    const found = await this.deps.db.selectFrom('reviews').select('id').where('workspace_id', '=', workspaceId)
      .where('id', '=', reviewId).executeTakeFirst();
    if (!found) throw new ApiError('REVIEW_NOT_FOUND', 'No such review in this workspace.');
    return (await this.store.read(found.id))!;
  }

  private async artifact(workspaceId: string, review: Review) {
    if (!review.candidateSha) throw new ApiError('INVALID_STATE', 'This review has no completed candidate build.');
    const result = await this.deps.git.readReview({ workspaceId, reviewId: review.id, candidateSha: review.candidateSha });
    if (canonical(result.artifact.source) !== canonical(review.source) || digest(result.artifact.context) !== review.source.contextHash) {
      throw new ApiError('INPUT_CONFLICT', 'Stored candidate does not match the review sources.');
    }
    return result;
  }

  async read(workspaceId: string, reviewId: string) {
    workspaceId = uuidSchema.parse(workspaceId).toLowerCase(); reviewId = uuidSchema.parse(reviewId).toLowerCase();
    const review = await this.scoped(workspaceId, reviewId);
    const { data } = await this.artifact(workspaceId, review);
    return reviewDetailSchema.parse({ review, ...data });
  }

  async preview(workspaceId: string, reviewId: string, path: string) {
    workspaceId = uuidSchema.parse(workspaceId).toLowerCase(); reviewId = uuidSchema.parse(reviewId).toLowerCase();
    const review = await this.scoped(workspaceId, reviewId);
    if (!review.candidateSha) throw new ApiError('INVALID_STATE', 'This review has no completed candidate build.');
    const artifact = await this.deps.git.readReviewArtifact({ workspaceId, reviewId, candidateSha: review.candidateSha });
    if (canonical(artifact.source) !== canonical(review.source) || digest(artifact.context) !== review.source.contextHash) {
      throw new ApiError('INPUT_CONFLICT', 'Stored candidate does not match the review sources.');
    }
    path = filePath(path);
    return this.deps.git.previewReview({ workspaceId, reviewId, candidateSha: review.candidateSha, path });
  }

  resolve(input: Parameters<ReviewService['resolve']>[0]): Promise<Review>;
  resolve(workspaceId: string, reviewId: string, input: ResolveCandidateRequest): Promise<ReviewDetail>;
  async resolve(target: string | Parameters<ReviewService['resolve']>[0], review?: string,
    request?: ResolveCandidateRequest): Promise<Review | ReviewDetail> {
    if (typeof target !== 'string') return (await this.resolve(target.workspaceId, target.reviewId,
      resolveCandidateRequestSchema.parse({ expectedCandidateSha: target.expectedCandidateSha, resolutions: target.resolutions }))).review;
    let workspaceId = target, reviewId = review!, input = request!;
    workspaceId = uuidSchema.parse(workspaceId).toLowerCase(); reviewId = uuidSchema.parse(reviewId).toLowerCase();
    input = resolveCandidateRequestSchema.parse(input);
    const found = await this.scoped(workspaceId, reviewId);
    return this.operations.run(found.taskId, async () => {
      const review = await this.scoped(workspaceId, reviewId);
      if (review.status !== 'conflict') throw new ApiError('INVALID_STATE', 'Only a conflicted review can be resolved.');
      if (review.candidateSha !== input.expectedCandidateSha) throw new ApiError('REVIEW_STALE', 'The candidate changed. Reload the review before resolving.');
      await this.artifact(workspaceId, review);
      const data = await this.deps.git.resolveReview({ workspaceId, reviewId, ...input });
      return this.finish(workspaceId, review, data, input.expectedCandidateSha);
    });
  }

  private async finish(workspaceId: string, review: Review, data: ReviewCandidateData, expected: string | null) {
    const collaboration = this.deps.collaboration;
    if (collaboration instanceof LiveDocumentCoordinator) {
      return this.deps.git.withApply(workspaceId, (git) => collaboration.withApply(review.taskId, async (live) => {
        if (await git.main() !== review.source.mainSha || !await live.isCurrent(review.source.documentRevisions)) {
          await this.invalidate({ taskId: review.taskId, reason: 'build:source_changed' });
          throw new ApiError('REVIEW_STALE', 'The draft changed while building. Request review again.');
        }
        return this.finishMetadata(workspaceId, review, data, expected);
      }));
    }
    return this.finishMetadata(workspaceId, review, data, expected);
  }

  private async finishMetadata(workspaceId: string, review: Review, data: ReviewCandidateData, expected: string | null) {
    await this.deps.db.transaction().execute(async (db) => {
      const task = await db.selectFrom('tasks').selectAll().where('workspace_id', '=', workspaceId)
        .where('id', '=', review.taskId).forUpdate().executeTakeFirstOrThrow();
      const workspace = await db.selectFrom('workspaces').select('guidance_version').where('id', '=', workspaceId).executeTakeFirstOrThrow();
      if (task.version !== review.source.taskVersion || workspace.guidance_version !== review.source.guidanceVersion || task.active_run_id ||
        ['completed', 'awaiting_confirmation', 'canceled'].includes(task.status)) {
        throw new ApiError('REVIEW_STALE', 'The task changed while preparing this candidate. Request review again.');
      }
      // Atomic candidate + state transition: there is never an intermediate ready conflict.
      const updated = await db.updateTable('reviews').set({ candidate_sha: data.candidateSha,
        status: data.candidateComplete ? 'ready' : 'conflict', updated_at: new Date() })
        .where('workspace_id', '=', workspaceId).where('id', '=', review.id)
        .where('status', '=', expected ? 'conflict' : 'building')
        .where('candidate_sha', expected ? '=' : 'is', expected).returning('id').executeTakeFirst();
      if (!updated) throw new ApiError('REVIEW_STALE', 'The review changed before the candidate could be saved.');
      await db.updateTable('tasks').set({ status: data.candidateComplete ? 'ready_for_review' : 'conflict', updated_at: new Date() })
        .where('id', '=', review.taskId).execute();
      if (data.candidateComplete) await appendEvent(db, { workspaceId, taskId: review.taskId, runId: review.runId,
        eventKey: eventKeys.reviewReady(review.id, data.candidateSha), type: 'review.ready', payload: { reviewId: review.id, candidateSha: data.candidateSha } });
    });
    return reviewDetailSchema.parse({ review: await this.store.read(review.id), ...data });
  }
}
