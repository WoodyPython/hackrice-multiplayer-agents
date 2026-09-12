import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ReviewSource, reviewCandidateDataSchema } from '@app/contracts';
import { LocalGitService } from '../src/git/service.js';
import { runGit, type GitRunner } from '../src/git/command.js';

let root: string, git: LocalGitService, repository: string;
let workspaceId: string, taskId: string, reviewId: string, approved: string;
const path = 'documents/shared.md';
const original = 'first\nsecond\nthird\nfourth\nfifth\n';
const command = async (...args: string[]) => (await runGit(['--git-dir', repository, ...args])).stdout.trim();
const checkpoint = (id: string, files: Array<{ path: string; text: string }>) => git.checkpoint({ workspaceId, taskId: id, files });
const content = async (sha: string, name = path) => (await git.readText({ workspaceId,
  target: { kind: 'commit', commitSha: sha }, path: name, allowedPaths: [name] })).text;
const build = (source: ReviewSource) => git.buildReview({ workspaceId, taskId, reviewId, source });
const source = (humanSha: string, resultSha: string | null = null, mainSha = approved): ReviewSource => ({
  mainSha, humanSha, resultSha, taskVersion: 1, guidanceVersion: 1, documentRevisions: {}, contextHash: 'test',
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'd06-git-'));
  workspaceId = randomUUID(); taskId = randomUUID(); reviewId = randomUUID(); git = new LocalGitService(root);
  repository = (await git.ensureRepository(workspaceId)).repositoryPath;
  approved = (await checkpoint(randomUUID(), [{ path, text: original }])).commitSha;
  await command('update-ref', 'refs/heads/main', approved);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function agent(base: string, text: string | null, name = path) {
  const runId = randomUUID(), agentInstanceId = randomUUID();
  await git.createResult({ workspaceId, runId, baseSha: base });
  await git.createWorker({ workspaceId, agentInstanceId, baseSha: base });
  const prior = await git.readText({ workspaceId, target: { kind: 'commit', commitSha: base }, path: name, allowedPaths: [name] });
  const changed = await git.applyWorkerChanges({ workspaceId, agentInstanceId, allowedWritePaths: [name],
    changes: [{ path: name, expectedHash: prior.hash, newText: text }] });
  const integrated = await git.integrate({ workspaceId, runId, agentInstanceId });
  return { sha: integrated.resultSha, runId, agentInstanceId, workerSha: changed.commitSha };
}

describe('D06 Git review candidates', { timeout: 120_000 }, () => {
  it('D07 publishes once with expected-main comparison and preserves source branches', async () => {
    const human = await checkpoint(taskId, [{ path, text: 'reviewed' }, { path: 'code/new.ts', text: 'export {};' }]);
    const candidate = await build(source(human.commitSha));
    const published = await git.applyExpected({ workspaceId, expectedMainSha: approved, candidateSha: candidate.candidateSha });
    expect(published).toEqual({ applied: true, currentMainSha: candidate.candidateSha });
    expect(await content(candidate.candidateSha)).toBe('reviewed');
    expect(await content(candidate.candidateSha, 'code/new.ts')).toBe('export {};');
    expect(await command('rev-parse', `refs/heads/human/${taskId}`)).toBe(human.commitSha);
    expect(await git.applyExpected({ workspaceId, expectedMainSha: approved, candidateSha: human.commitSha }))
      .toEqual({ applied: false, currentMainSha: candidate.candidateSha });
    expect(await command('rev-parse', 'main')).toBe(candidate.candidateSha);
  });

  it('D07 rejects absent, invalid and foreign candidate commits', async () => {
    const other = randomUUID();
    const foreign = await git.checkpoint({ workspaceId: other, taskId: randomUUID(), files: [{ path, text: 'foreign' }] });
    for (const candidateSha of ['bad', 'f'.repeat(40), foreign.commitSha]) {
      await expect(git.applyExpected({ workspaceId, expectedMainSha: approved, candidateSha })).rejects.toBeDefined();
      expect(await command('rev-parse', 'main')).toBe(approved);
    }
  });
  it('combines manual edits and newer approved changes, returns real diffs, and leaves every source intact', async () => {
    const human = await checkpoint(taskId, [{ path, text: original.replace('first', 'human') }]);
    const main = await checkpoint(randomUUID(), [{ path: 'code/new.ts', text: 'inert();' }]);
    await command('update-ref', 'refs/heads/main', main.commitSha, approved);
    const result = await build(source(human.commitSha, null, main.commitSha));
    expect(reviewCandidateDataSchema.parse(result.data).candidateComplete).toBe(true);
    expect(await content(result.candidateSha)).toBe(original.replace('first', 'human'));
    expect(await content(result.candidateSha, 'code/new.ts')).toBe('inert();');
    expect(result.data.changedFiles.map((f) => f.path)).toEqual([path]);
    expect(result.data.changedFiles[0]!.diff).toContain('+human');
    expect(await command('rev-parse', 'main')).toBe(main.commitSha);
    expect(await command('rev-parse', `human/${taskId}`)).toBe(human.commitSha);
    expect((await readdir(repository)).filter((name) => name.startsWith('review-'))).toEqual([]);
    expect(await command('worktree', 'list', '--porcelain')).not.toContain('review-');
  });

  it('merges separate human and agent edits in the same file and preserves integrated/worker branches', async () => {
    const start = await checkpoint(taskId, []);
    const worker = await agent(start.commitSha, original.replace('fifth', 'agent'));
    const human = await checkpoint(taskId, [{ path, text: original.replace('first', 'human') }]);
    const result = await build(source(human.commitSha, worker.sha));
    expect(result.conflicts).toEqual([]);
    expect(await content(result.candidateSha)).toBe(original.replace('first', 'human').replace('fifth', 'agent'));
    expect(await command('rev-parse', `results/${worker.runId}`)).toBe(worker.sha);
    expect(await command('rev-parse', `agents/${worker.agentInstanceId}`)).toBe(worker.workerSha);
    expect(await command('rev-parse', 'main')).toBe(approved);
  });

  it.each(['human_draft', 'agent_result', 'manual'] as const)('resolves human/agent conflict with %s into a new immutable candidate', async (choice) => {
    const start = await checkpoint(taskId, []), worker = await agent(start.commitSha, 'agent\n');
    const human = await checkpoint(taskId, [{ path, text: 'human\n' }]);
    const result = await build(source(human.commitSha, worker.sha));
    expect(result.data.conflicts).toMatchObject([{ path, stage: 'human_agent', sides: [{ side: 'human_draft', text: 'human\n' }, { side: 'agent_result', text: 'agent\n' }] }]);
    const next = await git.resolveReview({ workspaceId, reviewId, expectedCandidateSha: result.candidateSha,
      resolutions: [{ path, choice, ...(choice === 'manual' ? { text: 'manual\n' } : {}) }] });
    expect(next.candidateComplete).toBe(true); expect(next.candidateSha).not.toBe(result.candidateSha);
    expect(await content(next.candidateSha)).toBe(choice === 'manual' ? 'manual\n' : choice === 'human_draft' ? 'human\n' : 'agent\n');
    const old = await git.readReview({ workspaceId, reviewId, candidateSha: result.candidateSha });
    expect(old.data.candidateComplete).toBe(false);
    expect(old.artifact.source).toEqual(source(human.commitSha, worker.sha));
  });

  it('exposes and resolves a second merge-stage conflict without losing first-stage choices', async () => {
    const start = await checkpoint(taskId, []), worker = await agent(start.commitSha, 'agent\n');
    const human = await checkpoint(taskId, [{ path, text: 'human\n' }]);
    const main = await checkpoint(randomUUID(), [{ path, text: 'approved\n' }]);
    await command('update-ref', 'refs/heads/main', main.commitSha, approved);
    const first = await build(source(human.commitSha, worker.sha, main.commitSha));
    const second = await git.resolveReview({ workspaceId, reviewId, expectedCandidateSha: first.candidateSha,
      resolutions: [{ path, choice: 'manual', text: 'combined\n' }] });
    expect(second.conflicts).toMatchObject([{ stage: 'task_main', sides: [{ side: 'combined_task', text: 'combined\n' }, { side: 'approved_main', text: 'approved\n' }] }]);
    const final = await git.resolveReview({ workspaceId, reviewId, expectedCandidateSha: second.candidateSha,
      resolutions: [{ path, choice: 'combined_task' }] });
    expect(final.candidateComplete).toBe(true); expect(await content(final.candidateSha)).toBe('combined\n');
    const approvedChoice = await git.resolveReview({ workspaceId, reviewId, expectedCandidateSha: second.candidateSha,
      resolutions: [{ path, choice: 'approved_main' }] });
    expect(await content(approvedChoice.candidateSha)).toBe('approved\n');
    expect(approvedChoice.changedFiles).toEqual([]);
    expect(await command('rev-parse', 'main')).toBe(main.commitSha);
  });

  it('resolves modification/deletion conflicts by choosing the absent side', async () => {
    const start = await checkpoint(taskId, []), worker = await agent(start.commitSha, null);
    const human = await checkpoint(taskId, [{ path, text: 'human' }]);
    const first = await build(source(human.commitSha, worker.sha));
    expect(first.data.conflicts[0]!.sides[1]).toEqual({ side: 'agent_result', text: null, sha: null });
    const result = await git.resolveReview({ workspaceId, reviewId, expectedCandidateSha: first.candidateSha,
      resolutions: [{ path, choice: 'agent_result' }] });
    expect(await content(result.candidateSha)).toBeNull();
    expect(result.changedFiles[0]!.changeKind).toBe('deleted');
  });

  it.each(['case', 'directory'] as const)('reports and resolves %s namespace collisions with original paths', async (kind) => {
    const start = await checkpoint(taskId, []);
    const leftPath = kind === 'case' ? 'code/A.ts' : 'code/a.ts';
    const rightPath = kind === 'case' ? 'code/a.ts' : 'code/a.ts/b.ts';
    const worker = await agent(start.commitSha, 'agent', rightPath);
    const human = await checkpoint(taskId, [{ path: leftPath, text: 'human' }]);
    const first = await build(source(human.commitSha, worker.sha));
    expect(first.conflicts).toEqual([leftPath, rightPath].sort());
    const result = await git.resolveReview({ workspaceId, reviewId, expectedCandidateSha: first.candidateSha,
      resolutions: first.conflicts.map((path) => ({ path, choice: 'agent_result' as const })) });
    expect(result.candidateComplete).toBe(true); expect(await content(result.candidateSha, rightPath)).toBe('agent');
    expect((await git.previewReview({ workspaceId, reviewId, candidateSha: result.candidateSha, path: leftPath })).text).toBeNull();
  });

  it('preserves literal marker text and reports an empty diff for identical content', async () => {
    const human = await checkpoint(taskId, [{ path, text: '<<<<<<< literal\n=======\n>>>>>>> example\n' }]);
    const first = await build(source(human.commitSha));
    expect(first.conflicts).toEqual([]);
    expect(await content(first.candidateSha)).toContain('<<<<<<< literal');
    const same = await git.buildReview({ workspaceId, taskId, reviewId: randomUUID(), source: source(approved) });
    expect(same.data.changedFiles).toEqual([]);
  });

  it('rejects duplicate, missing, extra, unavailable-source and unsafe manual resolutions without changing candidates', async () => {
    const start = await checkpoint(taskId, []), worker = await agent(start.commitSha, 'agent');
    const human = await checkpoint(taskId, [{ path, text: 'human' }]);
    const first = await build(source(human.commitSha, worker.sha));
    for (const resolutions of [[], [{ path, choice: 'approved_main' }], [{ path: 'code/unrelated.ts', choice: 'manual', text: 'bad' }],
      [{ path, choice: 'manual', text: 'x' }, { path, choice: 'manual', text: 'y' }], [{ path, choice: 'manual' }],
      [{ path, choice: 'manual', text: '\0' }], [{ path, choice: 'manual', text: '\ud800' }],
      [{ path: '../escape.md', choice: 'manual', text: 'bad' }]]) {
      await expect(git.resolveReview({ workspaceId, reviewId, expectedCandidateSha: first.candidateSha, resolutions } as never)).rejects.toBeDefined();
    }
    expect((await git.readReview({ workspaceId, reviewId, candidateSha: first.candidateSha })).data.candidateComplete).toBe(false);
    expect(await command('rev-parse', 'main')).toBe(approved);
  });

  it('rejects unrelated commits and cleans scratch storage on Git failure', async () => {
    const tree = await command('rev-parse', `${approved}^{tree}`);
    const unrelated = await command('commit-tree', tree, '-m', 'Unrelated');
    await expect(build(source(unrelated))).rejects.toMatchObject({ code: 'INPUT_CONFLICT' });
    const failing: GitRunner = (args, options) => {
      if (args.includes('commit-tree')) return Promise.reject(new Error('secret filesystem location'));
      return runGit(args, options);
    };
    const badGit = new LocalGitService(root, undefined, failing);
    await expect(badGit.buildReview({ workspaceId, taskId, source: source(approved) })).rejects.toMatchObject({ code: 'FILE_OPERATION_FAILED' });
    expect(await command('rev-parse', 'main')).toBe(approved);
    expect((await readdir(repository)).filter((name) => name.startsWith('review-'))).toEqual([]);
  });

  it('serves durable review artifacts from a new service instance and rejects cross-workspace access', async () => {
    const human = await checkpoint(taskId, [{ path, text: 'saved' }]);
    const [a, b] = await Promise.all([build(source(human.commitSha)), git.buildReview({ workspaceId, taskId, reviewId: randomUUID(), source: source(human.commitSha) })]);
    expect(a.data.candidateComplete && b.data.candidateComplete).toBe(true);
    const fresh = new LocalGitService(root);
    expect((await fresh.readReview({ workspaceId, reviewId, candidateSha: a.candidateSha })).data).toEqual(a.data);
    await expect(fresh.readReview({ workspaceId: randomUUID(), reviewId, candidateSha: a.candidateSha })).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
  });
});
