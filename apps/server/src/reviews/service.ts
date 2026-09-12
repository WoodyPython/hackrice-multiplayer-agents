import { createHash } from 'node:crypto';
import {
  ApiError, contextManifestSchema, eventKeys, reviewDetailSchema, reviewSourceSchema, resolveCandidateRequestSchema,
  uuidSchema, type CollaborationService, type Review, type ReviewCandidateData, type ResolveCandidateRequest,
  type ReviewService, type ReviewDetail,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import { appendEvent } from '../events/service.js';
import { LocalGitService } from '../git/service.js';
import { PgReviewStore } from '../runs/review-store.js';
import { TaskDocumentGate } from '../collaboration/gate.js';
import { filePath } from '../git/files.js';

/** Stable context digest; D04's digest alone only identifies the captured draft. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

export class LocalReviewService implements Pick<ReviewService, 'prepare' | 'resolve'> {
  private readonly store: PgReviewStore;
  // Serializes prepare/resolve for a task; never acquired from inside a Git/document gate.
  private readonly operations = new TaskDocumentGate();
  constructor(private readonly deps: { db: Db; git: LocalGitService; collaboration: Pick<CollaborationService, 'capture'> }) {
    this.store = new PgReviewStore({ db: deps.db });
  }

  private async inputs(workspaceId: string, taskId: string) {
    // A short consistent DB snapshot. Never hold it during Git or document capture.
    return this.deps.db.transaction().setIsolationLevel('repeatable read').execute(async (db) => {
      const workspace = await db.selectFrom('workspaces').select(['id', 'guidance', 'guidance_version'])
        .where('id', '=', workspaceId).executeTakeFirst();
      if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND', 'No such workspace.');
      const task = await db.selectFrom('tasks').selectAll().where('workspace_id', '=', workspaceId)
        .where('id', '=', taskId).executeTakeFirst();
      if (!task) throw new ApiError('TASK_NOT_FOUND', 'No such task in this workspace.');
      if (task.active_run_id || ['completed', 'canceled'].includes(task.status) ||
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
    });
  }

  prepare(input: Parameters<ReviewService['prepare']>[0]): Promise<Review>;
  prepare(workspaceId: string, taskId: string): Promise<ReviewDetail>;
  async prepare(input: string | Parameters<ReviewService['prepare']>[0], task?: string): Promise<Review | ReviewDetail> {
    if (typeof input !== 'string') return (await this.prepare(input.workspaceId, input.taskId)).review;
    let workspaceId = input, taskId = task!;
    workspaceId = uuidSchema.parse(workspaceId).toLowerCase(); taskId = uuidSchema.parse(taskId).toLowerCase();
    return this.operations.run(taskId, async () => {
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
    const detail = await this.read(workspaceId, reviewId);
    path = filePath(path);
    return this.deps.git.previewReview({ workspaceId, reviewId, candidateSha: detail.candidateSha, path });
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
    await this.deps.db.transaction().execute(async (db) => {
      const task = await db.selectFrom('tasks').selectAll().where('workspace_id', '=', workspaceId)
        .where('id', '=', review.taskId).forUpdate().executeTakeFirstOrThrow();
      const workspace = await db.selectFrom('workspaces').select('guidance_version').where('id', '=', workspaceId).executeTakeFirstOrThrow();
      if (task.version !== review.source.taskVersion || workspace.guidance_version !== review.source.guidanceVersion || task.active_run_id ||
        ['completed', 'canceled'].includes(task.status)) {
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
