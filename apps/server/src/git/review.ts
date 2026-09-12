import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ApiError, candidateConflictSchema, candidateResolutionSchema, reviewSourceSchema, shaSchema,
  type CandidateConflict, type CandidateResolution, type ReviewSource, type ReviewCandidateData,
} from '@app/contracts';
import { GitRuntimeError, type GitRunner } from './command.js';
import { decodeText, filePath, portablePaths, textBytes } from './files.js';
import { ManagedWorktrees, type Tree } from './worktrees.js';

const savedResolution = z.object({ stage: z.enum(['human_agent', 'task_main']), resolution: candidateResolutionSchema });
const artifactSchema = z.object({
  source: reviewSourceSchema, candidateSha: shaSchema,
  resolutions: z.array(savedResolution), conflicts: z.array(candidateConflictSchema),
  context: z.record(z.string(), z.unknown()),
});
export type ReviewArtifact = z.infer<typeof artifactSchema>;
type Entry = Tree extends Map<string, infer E> ? E : never;
const equal = (a?: Entry, b?: Entry) => a?.hash === b?.hash && a?.mode === b?.mode;

/** Internal capability: constructed only while the workspace Git lock is held. */
export class ReviewGit {
  constructor(private readonly repository: string, private readonly files: ManagedWorktrees,
    private readonly runner: GitRunner) {}

  private command(args: string[], options?: Parameters<GitRunner>[1]) {
    return this.runner(['--git-dir', this.repository, ...args], options);
  }

  private async validatedTree(sha: string) {
    const tree = await this.files.tree(sha);
    for (const entry of tree.values()) await this.files.blob(entry.hash);
    return tree;
  }

  private async base(a: string, b: string) {
    const result = await this.command(['merge-base', '--all', a, b], { allowedExitCodes: [1] });
    const bases = result.stdout.trim().split('\n');
    if (result.exitCode !== 0 || bases.length !== 1 || !shaSchema.safeParse(bases[0]).success) {
      throw new ApiError('INPUT_CONFLICT', 'Review sources must have one unambiguous common base.');
    }
    return bases[0]!;
  }

  private async hash(bytes: Buffer) {
    return shaSchema.parse((await this.command(['hash-object', '-w', '--stdin', '--no-filters'], { input: bytes })).stdout.trim());
  }

  private async side(side: CandidateConflict['sides'][number]['side'], entry?: Entry) {
    return { side, sha: entry?.hash ?? null, text: entry ? decodeText(await this.files.blob(entry.hash)) : null };
  }

  private async writeTree(tree: Tree, indexFile: string) {
    portablePaths(tree.keys());
    await this.command(['read-tree', '--empty'], { indexFile });
    const records = [...tree].sort(([a], [b]) => a < b ? -1 : 1)
      .map(([path, entry]) => `${entry.mode} ${entry.hash}\t${path}\0`).join('');
    if (records) await this.command(['update-index', '-z', '--index-info'], { indexFile, input: records });
    if ((await this.command(['ls-files', '--unmerged', '-z'], { indexFile })).stdout.length) {
      throw new ApiError('REVIEW_CONFLICT', 'Resolve every Git index entry before reviewing this candidate.');
    }
    return shaSchema.parse((await this.command(['write-tree'], { indexFile })).stdout.trim());
  }

  private async merge(baseSha: string, leftSha: string, rightSha: string,
    stage: CandidateConflict['stage'], saved: ReviewArtifact['resolutions'], scratch: string) {
    const base = await this.validatedTree(baseSha), left = await this.validatedTree(leftSha), right = await this.validatedTree(rightSha);
    const proposed: Tree = new Map();
    const unresolved = new Set<string>();
    const paths = [...new Set([...base.keys(), ...left.keys(), ...right.keys()])].sort();
    const leftLabel = stage === 'human_agent' ? 'human_draft' : 'combined_task';
    const rightLabel = stage === 'human_agent' ? 'agent_result' : 'approved_main';
    const choices = new Map(saved.filter((r) => r.stage === stage).map((r) => [r.resolution.path, r.resolution]));
    for (const path of paths) {
      const b = base.get(path), l = left.get(path), r = right.get(path);
      let chosen: Entry | undefined;
      if (equal(l, r) || equal(b, r)) chosen = l;
      else if (equal(b, l)) chosen = r;
      else {
        let clean = false;
        if (b && l && r) {
          const mode = l.mode === r.mode ? l.mode : l.mode === b.mode ? r.mode : r.mode === b.mode ? l.mode : undefined;
          if (mode) {
            const names = ['left', 'base', 'right'].map((name) => join(scratch, name));
            for (const [i, entry] of [l, b, r].entries()) await writeFile(names[i]!, await this.files.blob(entry.hash));
            const merged = await this.command(['merge-file', '-p', ...names], {
              binary: true, allowedExitCodes: Array.from({ length: 127 }, (_, i) => i + 1),
            });
            if (merged.exitCode === 0) {
              decodeText(merged.stdoutBytes!);
              chosen = { mode, hash: await this.hash(merged.stdoutBytes!) }; clean = true;
            }
          }
        }
        if (!clean) { unresolved.add(path); chosen = l; }
      }
      if (chosen) proposed.set(path, chosen);
    }
    // Namespace conflicts concern the proposed tree, including paths absent on a side.
    const collisions = (tree: Tree) => {
      const result = new Set<string>(), names = [...tree.keys()];
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        try { portablePaths([names[i]!, names[j]!]); }
        catch { result.add(names[i]!); result.add(names[j]!); }
      }
      return result;
    };
    for (const path of collisions(proposed)) unresolved.add(path);
    for (const [path, choice] of choices) {
      if (!unresolved.has(path)) throw new ApiError('REVIEW_CONFLICT', 'A saved resolution does not match this conflict.', { path });
      let value: Entry | undefined;
      if (choice.choice === 'manual') value = { mode: left.get(path)?.mode ?? right.get(path)?.mode ?? '100644', hash: await this.hash(textBytes(choice.text!)) };
      else if (choice.choice === leftLabel) value = left.get(path);
      else if (choice.choice === rightLabel) value = right.get(path);
      else throw new ApiError('REVIEW_CONFLICT', 'Choose a source offered for this merge stage.', { path });
      if (value) proposed.set(path, value); else proposed.delete(path);
      unresolved.delete(path);
    }
    if (choices.size && collisions(proposed).size) {
      throw new ApiError('REVIEW_CONFLICT', 'These resolutions still produce conflicting file paths.');
    }
    const conflicts: CandidateConflict[] = [];
    for (const path of [...unresolved].sort()) conflicts.push({ path, stage,
      sides: [await this.side(leftLabel, left.get(path)), await this.side(rightLabel, right.get(path))] });

    // Keep actual unresolved stages in a disposable index, never marker text in a deliverable.
    const indexFile = join(scratch, 'index');
    if (conflicts.length) {
      await this.command(['read-tree', '--empty'], { indexFile });
      let records = '';
      for (const { path } of conflicts) for (const [i, tree] of [base, left, right].entries()) {
        const entry = tree.get(path);
        if (entry) records += `${entry.mode} ${entry.hash} ${i + 1}\t${path}\0`;
      }
      if (records) await this.command(['update-index', '-z', '--index-info'], { indexFile, input: records });
      // Provisional tree is explicitly incomplete. Preserve automatic merges when portable.
      const previewTree = collisions(proposed).size ? left : proposed;
      return { treeSha: await this.writeTree(previewTree, join(scratch, 'preview-index')), conflicts };
    }
    return { treeSha: await this.writeTree(proposed, indexFile), conflicts };
  }

  async build(reviewId: string, source: ReviewSource, context: Record<string, unknown> = {},
    resolutions: ReviewArtifact['resolutions'] = [], previousCandidate?: string): Promise<ReviewArtifact> {
    for (const sha of new Set([source.mainSha, source.humanSha, ...(source.resultSha ? [source.resultSha] : [])])) {
      await this.files.commit(sha); await this.validatedTree(sha);
    }
    const scratch = await mkdtemp(join(this.repository, 'review-'));
    const worktree = join(scratch, 'worktree');
    let attached = false;
    try {
      await this.command(['worktree', 'add', '--detach', '--no-checkout', worktree, source.mainSha]); attached = true;
      let human = source.humanSha;
      let conflicts: CandidateConflict[] = [];
      let treeSha: string | undefined;
      if (source.resultSha) {
        const merged = await this.merge(await this.base(human, source.resultSha), human, source.resultSha, 'human_agent', resolutions, scratch);
        conflicts = merged.conflicts; treeSha = merged.treeSha;
        if (!conflicts.length) human = shaSchema.parse((await this.command(['commit-tree', treeSha,
          ...[...new Set([human, source.resultSha])].flatMap((sha) => ['-p', sha]), '-m', `Combine review ${reviewId}`])).stdout.trim());
      }
      if (!conflicts.length) {
        const merged = await this.merge(await this.base(human, source.mainSha), human, source.mainSha, 'task_main', resolutions, scratch);
        conflicts = merged.conflicts; treeSha = merged.treeSha;
      }
      // Keep every immutable source reachable, including G while the first stage is conflicted.
      const parents = [...new Set([source.mainSha, human, ...(source.resultSha ? [source.resultSha] : []),
        ...(previousCandidate ? [previousCandidate] : [])])];
      const candidateSha = shaSchema.parse((await this.command(['commit-tree', treeSha!,
        ...parents.flatMap((sha) => ['-p', sha]), '-m', `Review candidate ${reviewId}${conflicts.length ? ' (unresolved)' : ''}`])).stdout.trim());
      const artifact = artifactSchema.parse({ source, candidateSha, context, resolutions, conflicts });
      const metadataBytes = Buffer.from(JSON.stringify(artifact), 'utf8');
      if (metadataBytes.length > 16 * 1024 * 1024) throw new ApiError('VALIDATION_FAILED', 'Review metadata exceeds the Git transport limit.');
      const metadata = await this.hash(metadataBytes);
      const prefix = `refs/app/reviews/${reviewId}/${candidateSha}`;
      const exists = await this.command(['show-ref', '--verify', '--quiet', `${prefix}/commit`], { allowedExitCodes: [1] });
      if (exists.exitCode !== 0) await this.command(['update-ref', '--stdin'], { input:
        `start\ncreate ${prefix}/commit ${candidateSha}\ncreate ${prefix}/metadata ${metadata}\nprepare\ncommit\n` });
      else {
        const old = await this.read(reviewId, candidateSha);
        if (JSON.stringify(old) !== JSON.stringify(artifact)) throw new ApiError('CONFLICT', 'Candidate identity already belongs to another review artifact.');
      }
      return artifact;
    } finally {
      // Only server-allocated temporary worktree paths are removed. Durable refs remain.
      if (attached) await this.command(['worktree', 'remove', '--force', worktree]);
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async read(reviewId: string, candidateSha: string): Promise<ReviewArtifact> {
    const ref = `refs/app/reviews/${reviewId}/${candidateSha}/metadata`;
    const found = await this.command(['show-ref', '--verify', '--hash', ref], { allowedExitCodes: [1, 128] });
    if (found.exitCode !== 0) throw new ApiError('REVIEW_NOT_FOUND', 'Review candidate is unavailable.');
    const size = Number((await this.command(['cat-file', '-s', found.stdout.trim()])).stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) throw new GitRuntimeError('INVALID_REVIEW_ARTIFACT');
    const result = artifactSchema.parse(JSON.parse((await this.command(['cat-file', 'blob', found.stdout.trim()])).stdout));
    if (result.candidateSha !== candidateSha) throw new GitRuntimeError('INVALID_REVIEW_ARTIFACT');
    return result;
  }

  async resolve(reviewId: string, artifact: ReviewArtifact, resolutions: CandidateResolution[]) {
    const requested = new Map(resolutions.map((r) => [filePath(r.path), r]));
    if (requested.size !== resolutions.length || requested.size !== artifact.conflicts.length ||
      artifact.conflicts.some((c) => !requested.has(c.path))) {
      throw new ApiError('REVIEW_CONFLICT', 'Supply exactly one resolution for every displayed conflict.');
    }
    const saved = [...artifact.resolutions];
    for (const conflict of artifact.conflicts) {
      const resolution = requested.get(conflict.path)!;
      if (resolution.choice !== 'manual' && !conflict.sides.some((s) => s.side === resolution.choice)) {
        throw new ApiError('REVIEW_CONFLICT', 'This source is not offered for the conflicted file.', { path: conflict.path });
      }
      saved.push({ stage: conflict.stage, resolution });
    }
    return this.build(reviewId, artifact.source, artifact.context, saved, artifact.candidateSha);
  }

  async detail(artifact: ReviewArtifact): Promise<ReviewCandidateData> {
    const before = await this.validatedTree(artifact.source.mainSha), after = await this.validatedTree(artifact.candidateSha);
    const changedFiles: ReviewCandidateData['changedFiles'] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const a = before.get(path), b = after.get(path);
      if (equal(a, b)) continue;
      const diff = await this.command(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
        '--no-color', '--src-prefix=a/', '--dst-prefix=b/', artifact.source.mainSha, artifact.candidateSha, '--', path]);
      changedFiles.push({ path, changeKind: !a ? 'added' : !b ? 'deleted' : 'modified', diff: diff.stdout,
        beforeHash: a?.hash ?? null, afterHash: b?.hash ?? null });
    }
    return { candidateSha: artifact.candidateSha, candidateComplete: artifact.conflicts.length === 0,
      conflicts: artifact.conflicts, changedFiles, generatedCodeWasNotExecuted: true };
  }

  async preview(artifact: ReviewArtifact, path: string) {
    path = filePath(path);
    const tree = await this.validatedTree(artifact.candidateSha);
    const entry = tree.get(path);
    // An absent/deleted path may alias a retained path. No filesystem access is involved.
    return { candidateSha: artifact.candidateSha, candidateComplete: !artifact.conflicts.length,
      path, text: entry ? decodeText(await this.files.blob(entry.hash)) : null, hash: entry?.hash ?? null };
  }
}
