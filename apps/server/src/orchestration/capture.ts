import {
  isActiveRunStatus, planningContextSchema, repoPathSchema,
  type CollaborationService, type ContextManifest, type GitService,
  type MaterialService, type PlanningContext, type StartSnapshotService,
} from '@app/contracts';
import type { Db } from '../db/client.js';
import type { PgDraftStore } from '../drafts/store.js';

/**
 * C06 capture: design section 2.2 steps 4 to 6.
 *
 * Everything a run will ever read is frozen here, once, before the orchestrator
 * model is created. Nothing downstream re-reads live task text: C03 validates
 * the captured context against the run row, and C04 binds worker tools to the
 * stored manifest. That is why this module reads, and never writes, task state.
 */

export type CaptureFailure =
  /** Not this boot's active run. Someone else already owns its outcome. */
  | 'inactive'
  | 'task_version_changed'
  | 'guidance_version_changed'
  /** Section 8.4: approved main and the human draft cannot be combined. */
  | 'snapshot_conflict'
  | 'capture_failed';

export class CaptureError extends Error {
  override readonly name = 'CaptureError';
  constructor(readonly code: CaptureFailure, readonly paths: string[] = []) {
    super(`Start capture refused (${code}).`);
  }
}

export interface CaptureDeps {
  db: Db;
  bootId: string;
  git: Pick<GitService, 'initialize' | 'readText'> & StartSnapshotService;
  collaboration: Pick<CollaborationService, 'capture'>;
  materials: Pick<MaterialService, 'readSelected'>;
  drafts: Pick<PgDraftStore, 'listActiveForTask'>;
}

export interface CapturedStart {
  context: PlanningContext;
  inputSnapshotSha: string;
  draftCheckpointSha: string;
  /** Selections that could not be captured, for the durable capture event. */
  omitted: string[];
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export class StartCapture {
  constructor(private readonly deps: CaptureDeps) {}

  async capture(workspaceId: string, taskId: string, runId: string): Promise<CapturedStart> {
    const { db } = this.deps;
    const run = await db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst();
    // A run from a previous boot was marked interrupted at startup (section
    // 14.4); resurrecting it here would be exactly the late write that forbids.
    if (!run || run.boot_id !== this.deps.bootId || !isActiveRunStatus(run.status) ||
        run.workspace_id !== workspaceId || run.task_id !== taskId) throw new CaptureError('inactive');

    const task = await db.selectFrom('tasks').selectAll().where('id', '=', taskId)
      .where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!task || task.active_run_id !== runId) throw new CaptureError('inactive');
    // The run fixed its versions at creation and they are never edited. A task
    // revised in the gap before capture would otherwise be captured as text the
    // run's own version number does not describe.
    if (task.version !== run.task_version) throw new CaptureError('task_version_changed');

    const workspace = await db.selectFrom('workspaces').select(['guidance', 'guidance_version'])
      .where('id', '=', workspaceId).executeTakeFirstOrThrow();
    if (workspace.guidance_version !== run.guidance_version) throw new CaptureError('guidance_version_changed');

    const omitted: string[] = [];
    const outputPaths = task.output_paths.filter((path) => keep(path, omitted, 'outputPath'));
    // Section 2.3: entries above the cutoff never enter any agent's context for
    // this run, including assignments that have not started yet.
    const discussion = await db.selectFrom('discussion_entries').select(['seq', 'body'])
      .where('task_id', '=', taskId).where('seq', '<=', run.discussion_cutoff_seq)
      .orderBy('seq').execute();

    const sources: PlanningContext['sources'] = [];
    const materials = await this.materials(workspaceId, taskId, sources, omitted);
    const mainSha = (await this.deps.git.initialize(workspaceId)).mainSha;
    const approvedPaths = await this.approved(workspaceId, taskId, mainSha, sources, omitted);
    const draft = await this.deps.collaboration.capture({ workspaceId, taskId });
    const draftFileHashes = await this.draftFiles(workspaceId, taskId, draft.checkpointSha, sources, omitted);

    const manifest: ContextManifest = {
      taskVersion: run.task_version,
      guidanceVersion: run.guidance_version,
      discussionCutoffSeq: run.discussion_cutoff_seq,
      materials, approvedPaths, approvedCommitSha: mainSha,
      draftCheckpointSha: draft.checkpointSha, draftFileHashes,
    };

    // Section 8.4. Combined before planning so a conflict is surfaced without
    // spending a model call, and without touching main or the live draft.
    const snapshot = await this.deps.git.combineStartSnapshot({
      workspaceId, taskId, mainSha, draftSha: draft.checkpointSha,
    });
    if (snapshot.snapshotSha === null) throw new CaptureError('snapshot_conflict', snapshot.conflicts);

    const parsed = planningContextSchema.safeParse({
      task: { id: taskId, version: run.task_version, title: task.title, outcome: task.outcome,
        criteria: task.criteria, outputPaths },
      guidance: workspace.guidance, manifest, discussion, sources,
    });
    if (!parsed.success) throw new CaptureError('capture_failed');
    return { context: parsed.data, inputSnapshotSha: snapshot.snapshotSha,
      draftCheckpointSha: draft.checkpointSha, omitted };
  }

  /**
   * Section 3.3's union. Reading only `task_input_links` silently drops every
   * material someone attached to the task, because "selected by default" is not
   * a stored row. Writing a selection row at attach time is the tempting
   * alternative and is worse: a later wholesale replacement of the inputs would
   * drop it just as silently.
   */
  private async materials(workspaceId: string, taskId: string,
    sources: PlanningContext['sources'], omitted: string[]): Promise<ContextManifest['materials']> {
    const { db } = this.deps;
    const [selected, attached] = await Promise.all([
      db.selectFrom('task_input_links').select('material_id')
        .where('task_id', '=', taskId).where('material_id', 'is not', null).execute(),
      db.selectFrom('material_links').select('material_id').where('task_id', '=', taskId).execute(),
    ]);
    const ids = [...new Set([...selected.map((r) => r.material_id!), ...attached.map((r) => r.material_id)])];
    if (ids.length === 0) return [];
    const rows = await db.selectFrom('materials').select(['id'])
      .where('id', 'in', ids).where('workspace_id', '=', workspaceId).where('deleted_at', 'is', null)
      .orderBy('created_at').orderBy('id').execute();
    for (const id of ids) if (!rows.some((row) => row.id === id)) omitted.push(`material:${id}`);

    const captured: ContextManifest['materials'] = [];
    for (const row of rows) {
      // Pre-validated by B04: UTF-8, under 1 MiB, no NUL bytes, text extension.
      const { material, bytes } = await this.deps.materials.readSelected(workspaceId, row.id);
      let text: string;
      try { text = utf8.decode(bytes); }
      catch { throw new CaptureError('capture_failed'); }
      captured.push({ materialId: material.id, sha256: material.sha256 });
      sources.push({ kind: 'material', materialId: material.id, sha256: material.sha256, text });
    }
    return captured;
  }

  private async approved(workspaceId: string, taskId: string, mainSha: string,
    sources: PlanningContext['sources'], omitted: string[]): Promise<string[]> {
    const links = await this.deps.db.selectFrom('task_input_links').select('approved_path')
      .where('task_id', '=', taskId).where('approved_path', 'is not', null).execute();
    const candidates = [...new Set(links.map((row) => row.approved_path!))].sort();
    const captured: string[] = [];
    for (const path of candidates) {
      if (!keep(path, omitted, 'approved')) continue;
      const file = await this.deps.git.readText({
        workspaceId, target: { kind: 'commit', commitSha: mainSha }, path, allowedPaths: [path],
      });
      // A selection whose file is not on main is reported rather than captured
      // as empty text: an invented blank source reaches a model as evidence.
      if (file.text === null) { omitted.push(`approved:${path}`); continue; }
      captured.push(path);
      sources.push({ kind: 'approved', path, text: file.text });
    }
    return captured;
  }

  /**
   * Every active document of this task, read from the checkpoint D04 just made.
   * Section 3.3 treats the task's own drafts as selected context, and section
   * 8.6 lets a worker read them, so the manifest carries their exact blob
   * hashes rather than a live revision that can move underneath a worker.
   */
  private async draftFiles(workspaceId: string, taskId: string, checkpointSha: string,
    sources: PlanningContext['sources'], omitted: string[]): Promise<Record<string, string>> {
    const [active, links] = await Promise.all([
      this.deps.drafts.listActiveForTask(workspaceId, taskId),
      this.deps.db.selectFrom('task_input_links').select('draft_file_id')
        .where('task_id', '=', taskId).where('draft_file_id', 'is not', null).execute(),
    ]);
    // A draft selected from another task lives on that task's own branch and is
    // not in this checkpoint. Report it instead of reading the wrong file.
    for (const row of links) {
      if (!active.some((file) => file.id === row.draft_file_id)) omitted.push(`draft:${row.draft_file_id!}`);
    }
    const hashes: Record<string, string> = {};
    for (const path of [...new Set(active.map((file) => file.path))].sort()) {
      if (!keep(path, omitted, 'draft')) continue;
      const file = await this.deps.git.readText({
        workspaceId, target: { kind: 'commit', commitSha: checkpointSha }, path, allowedPaths: [path],
      });
      if (file.text === null || file.hash === null) { omitted.push(`draft:${path}`); continue; }
      hashes[path] = file.hash;
      sources.push({ kind: 'draft', path, text: file.text });
    }
    return hashes;
  }
}

/** Paths reach the model and the Git layer; an unusable one is dropped here. */
function keep(path: string, omitted: string[], kind: string): boolean {
  if (repoPathSchema.safeParse(path).success) return true;
  omitted.push(`${kind}:${path}`);
  return false;
}
