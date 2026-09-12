import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIntegrateResultSchema, MAX_TEXT_FILE_BYTES } from '@app/contracts';
import { LocalGitService } from '../src/git/service.js';
import { runGit, GitRuntimeError, type GitRunner } from '../src/git/command.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'd05-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(runner: GitRunner = runGit) {
  const git = new LocalGitService(join(root, 'data'), undefined, runner);
  const workspaceId = randomUUID(), taskId = randomUUID(), runId = randomUUID();
  const repo = await git.ensureRepository(workspaceId);
  const cmd = async (...args: string[]) => (await runGit(['--git-dir', repo.repositoryPath, ...args])).stdout.trim();
  const { commitSha: base } = await git.checkpoint({ workspaceId, taskId,
    files: [{ path: 'documents/a.md', text: 'first\nmiddle\nlast\n' }, { path: 'documents/z.md', text: 'original\n' }] });
  const result = await git.createResult({ workspaceId, runId, baseSha: base });
  async function worker(baseSha = base) {
    const agentInstanceId = randomUUID();
    await git.createWorker({ workspaceId, agentInstanceId, baseSha });
    const change = async (files: Record<string, string | null>) => {
      const changes = [];
      for (const [path, newText] of Object.entries(files)) {
        const { hash } = await git.readText({ workspaceId, target: { kind: 'worker', agentInstanceId }, path, allowedPaths: [path] });
        changes.push({ path, newText, expectedHash: hash });
      }
      return git.applyWorkerChanges({ workspaceId, agentInstanceId, allowedWritePaths: Object.keys(files), changes });
    };
    return { id: agentInstanceId, change, integrate: () => git.integrate({ workspaceId, runId, agentInstanceId }) };
  }
  return { git, workspaceId, taskId, runId, repo, base, result, worker, cmd };
}

// Real Git subprocesses on Windows can exceed the default 30s per scenario.
describe('D05 worker integration', { timeout: 120_000 }, () => {
  it('validates IDs before creating storage and checks response ordering', async () => {
    const git = new LocalGitService(join(root, 'absent'));
    const valid = { workspaceId: randomUUID(), runId: randomUUID(), agentInstanceId: randomUUID() };
    for (const key of Object.keys(valid)) await expect(git.integrate({ ...valid, [key]: '../escape' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readdir(root)).toEqual([]);
    expect(gitIntegrateResultSchema.safeParse({ resultSha: 'a'.repeat(40), conflicts: ['documents/z.md', 'documents/a.md'] }).success).toBe(false);
  });

  it('fast-forwards, preserves other branches, and supplies the next dependent base', async () => {
    const f = await fixture(); const a = await f.worker();
    const checkpoint = await a.change({ 'documents/a.md': 'worker\n' });
    expect(await a.integrate()).toEqual({ resultSha: checkpoint.commitSha, conflicts: [] });
    const b = await f.worker(checkpoint.commitSha);
    const next = await b.change({ 'documents/a.md': 'dependent\n' });
    expect((await b.integrate()).resultSha).toBe(next.commitSha);
    expect(await f.cmd('rev-parse', 'main')).toBe(f.repo.mainSha);
    expect(await f.cmd('rev-parse', `human/${f.taskId}`)).toBe(f.base);
    expect(await f.cmd('rev-parse', `agents/${a.id}`)).toBe(checkpoint.commitSha);
    expect(await readFile(join(f.result.worktreePath, 'documents/a.md'), 'utf8')).toBe('dependent\n');
    expect(await a.integrate()).toEqual({ resultSha: next.commitSha, conflicts: [] });
  });

  it('serializes parallel siblings and records both parents of the combined result', async () => {
    const f = await fixture(); const a = await f.worker(), b = await f.worker();
    const ca = await a.change({ 'documents/a.md': 'A\n' });
    const cb = await b.change({ 'documents/z.md': 'B\n' });
    const [ra, rb] = await Promise.all([a.integrate(), b.integrate()]);
    expect(ra).toEqual({ resultSha: ca.commitSha, conflicts: [] });
    expect(rb.conflicts).toEqual([]);
    expect(await f.cmd('show', '-s', '--format=%P', rb.resultSha)).toBe(`${ca.commitSha} ${cb.commitSha}`);
    expect(await f.cmd('show', `${rb.resultSha}:documents/a.md`)).toBe('A');
    expect(await f.cmd('show', `${rb.resultSha}:documents/z.md`)).toBe('B');
    expect((await a.integrate()).resultSha).toBe(rb.resultSha);
    expect((await b.integrate()).resultSha).toBe(rb.resultSha);
  });

  it('merges separate edits within one text file without treating literal markers as conflicts', async () => {
    const f = await fixture(); const a = await f.worker(), b = await f.worker();
    await a.change({ 'documents/a.md': 'FIRST\nmiddle\nlast\n' });
    await b.change({ 'documents/a.md': 'first\nmiddle\nLAST\n', 'documents/markers.md': '<<<<<<< literal\n' });
    await a.integrate(); const merged = await b.integrate();
    expect(merged.conflicts).toEqual([]);
    expect(await f.cmd('show', `${merged.resultSha}:documents/a.md`)).toBe('FIRST\nmiddle\nLAST');
  });

  it.each(['modify', 'add', 'delete', 'directory', 'case'] as const)('returns complete %s conflicts and preserves all published files', async (kind) => {
    const f = await fixture(); const a = await f.worker(), b = await f.worker();
    const left: Record<string, string | null> = { 'documents/z.md': 'left\n' };
    const right: Record<string, string | null> = { 'documents/z.md': 'right\n' };
    let expected = ['documents/a.md', 'documents/z.md'];
    if (kind === 'modify') { left['documents/a.md'] = 'left\n'; right['documents/a.md'] = 'right\n'; }
    if (kind === 'delete') { left['documents/a.md'] = null; right['documents/a.md'] = 'right\n'; }
    if (kind === 'add') { left['documents/new.md'] = 'left\n'; right['documents/new.md'] = 'right\n'; expected = ['documents/new.md', 'documents/z.md']; }
    if (kind === 'directory') { left['code/item.ts'] = 'file'; right['code/item.ts/child.ts'] = 'child'; expected = ['code/item.ts', 'code/item.ts/child.ts', 'documents/z.md']; }
    if (kind === 'case') { left['code/Item.ts'] = 'file'; right['code/item.ts'] = 'other'; expected = ['code/Item.ts', 'code/item.ts', 'documents/z.md']; }
    const ca = await a.change(left), cb = await b.change(right);
    await a.integrate();
    const before = await f.cmd('rev-list', '--all');
    expect(await b.integrate()).toEqual({ resultSha: ca.commitSha, conflicts: expected });
    expect(await f.cmd('rev-list', '--all')).toBe(before);
    expect(await f.cmd('rev-parse', `agents/${b.id}`)).toBe(cb.commitSha);
    expect(await readFile(join(f.result.worktreePath, 'documents/z.md'), 'utf8')).toBe('left\n');
    expect(await f.cmd('rev-parse', 'main')).toBe(f.repo.mainSha);
    expect(await f.cmd('rev-parse', `human/${f.taskId}`)).toBe(f.base);
    expect((await readdir(f.repo.repositoryPath)).filter((p) => p.startsWith('integration-'))).toEqual([]);
  });

  it('returns the current head for empty and net-zero workers', async () => {
    const f = await fixture(); const a = await f.worker();
    expect(await a.integrate()).toEqual({ resultSha: f.base, conflicts: [] });
    await a.change({ 'documents/z.md': 'temporary' });
    await a.change({ 'documents/z.md': 'original\n' });
    expect(await a.integrate()).toEqual({ resultSha: f.base, conflicts: [] });
  });

  it('rejects missing refs, invalid bases, and a worker whose prerequisite has not integrated', async () => {
    const f = await fixture();
    await expect(f.git.integrate({ workspaceId: f.workspaceId, runId: f.runId, agentInstanceId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const a = await f.worker(); const ca = await a.change({ 'documents/a.md': 'prerequisite' });
    const b = await f.worker(ca.commitSha);
    await expect(b.integrate()).rejects.toMatchObject({ code: 'INPUT_CONFLICT' });
    await f.cmd('update-ref', `refs/app/bases/agents/${a.id}`, ca.commitSha);
    await expect(a.integrate()).rejects.toMatchObject({ code: 'INPUT_CONFLICT' });
    await f.cmd('update-ref', '-d', `refs/app/bases/agents/${a.id}`);
    await expect(a.integrate()).rejects.toMatchObject({ code: 'INVALID_WORKTREE_REFS' });
    expect(await f.cmd('rev-parse', f.result.branch)).toBe(f.base);
  });

  it.each(['mode', 'utf8', 'size', 'extension'] as const)('rejects unsafe %s in committed worker content before publication', async (kind) => {
    const f = await fixture(); const a = await f.worker();
    const bytes = kind === 'utf8' ? Buffer.from([0xff]) : kind === 'size' ? Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 97) : Buffer.from('safe');
    const prefix = ['--git-dir', f.repo.repositoryPath];
    const indexFile = join(root, 'fixture-index');
    const hash = (await runGit([...prefix, 'hash-object', '-w', '--stdin'], { input: bytes })).stdout.trim();
    await runGit([...prefix, 'read-tree', f.base], { indexFile });
    await runGit([...prefix, 'update-index', '-z', '--index-info'], { indexFile,
      input: `${kind === 'mode' ? '120000' : '100644'} ${hash}\tcode/bad.${kind === 'extension' ? 'zip' : 'ts'}\0` });
    const tree = (await runGit([...prefix, 'write-tree'], { indexFile })).stdout.trim();
    const commit = await f.cmd('commit-tree', tree, '-p', f.base, '-m', 'unsafe fixture');
    await f.cmd('update-ref', `refs/heads/agents/${a.id}`, commit);
    await expect(a.integrate()).rejects.toMatchObject({ code: ['mode', 'extension'].includes(kind) ? 'INVALID_PATH' : 'VALIDATION_FAILED' });
    expect(await f.cmd('rev-parse', f.result.branch)).toBe(f.base);
  });

  it('preserves the old ref on CAS failure and repairs a published projection on retry', async () => {
    let failure: 'cas' | 'projection' | undefined;
    let published = false;
    const runner: GitRunner = async (args, options) => {
      if (args.includes('update-ref') && args.some((s) => s.startsWith('refs/heads/results/'))) {
        if (failure === 'cas') throw new GitRuntimeError('COMMAND_FAILED');
        const result = await runGit(args, options); published = true; return result;
      }
      if (published && failure === 'projection' && args.includes('read-tree')) throw new GitRuntimeError('COMMAND_FAILED');
      return runGit(args, options);
    };
    const f = await fixture(runner); const a = await f.worker();
    const ca = await a.change({ 'documents/a.md': 'saved' });
    failure = 'cas';
    await expect(a.integrate()).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(await f.cmd('rev-parse', f.result.branch)).toBe(f.base);
    failure = 'projection';
    await expect(a.integrate()).rejects.toMatchObject({ code: 'WORKTREE_SYNC_FAILED' });
    expect(await f.cmd('rev-parse', f.result.branch)).toBe(ca.commitSha);
    failure = undefined;
    expect(await a.integrate()).toEqual({ resultSha: ca.commitSha, conflicts: [] });
    expect(await readFile(join(f.result.worktreePath, 'documents/a.md'), 'utf8')).toBe('saved');
  });

  it('preserves unknown result-worktree edits and rejects publication', async () => {
    const f = await fixture(); const a = await f.worker();
    await a.change({ 'documents/a.md': 'worker' });
    const path = join(f.result.worktreePath, 'documents/a.md');
    await writeFile(path, 'operator edit');
    await expect(a.integrate()).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    expect(await readFile(path, 'utf8')).toBe('operator edit');
    expect(await f.cmd('rev-parse', f.result.branch)).toBe(f.base);
  });

  it('validates merged text size before publishing two individually valid workers', async () => {
    const f = await fixture(); const a = await f.worker(), b = await f.worker();
    const large = 'x'.repeat(600_000);
    await a.change({ 'documents/a.md': `${large}\nmiddle\nlast\n` });
    await b.change({ 'documents/a.md': `first\nmiddle\n${large}\n` });
    const first = await a.integrate();
    await expect(b.integrate()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await f.cmd('rev-parse', f.result.branch)).toBe(first.resultSha);
    expect(await readFile(join(f.result.worktreePath, 'documents/a.md'), 'utf8')).toBe(`${large}\nmiddle\nlast\n`);
  });

  it('rejects invalid worker objects and a base that is not an ancestor of its head', async () => {
    const f = await fixture(); const a = await f.worker(), b = await f.worker();
    const ca = await a.change({ 'documents/a.md': 'a' });
    const cb = await b.change({ 'documents/a.md': 'b' });
    await f.cmd('update-ref', `refs/app/bases/agents/${a.id}`, cb.commitSha);
    await expect(a.integrate()).rejects.toMatchObject({ code: 'INVALID_WORKTREE_REFS' });
    await f.cmd('update-ref', `refs/app/bases/agents/${a.id}`, f.base);
    const blob = await f.cmd('rev-parse', `${ca.commitSha}:documents/a.md`);
    // A base ref may point to a blob, but integration must reject it.
    await f.cmd('update-ref', `refs/app/bases/agents/${a.id}`, blob);
    await expect(a.integrate()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await writeFile(join(f.repo.repositoryPath, 'refs/app/bases/agents', a.id), 'f'.repeat(40) + '\n');
    await expect(a.integrate()).rejects.toBeInstanceOf(Error);
    expect(await f.cmd('rev-parse', f.result.branch)).toBe(f.base);
  });
});
