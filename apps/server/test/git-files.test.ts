import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_FILE_BYTES, type TextChange } from '@app/contracts';
import { GitRuntimeError, runGit, type GitRunner } from '../src/git/command.js';
import { blobHash, filePath, textBytes } from '../src/git/files.js';
import { LocalGitService } from '../src/git/service.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'd02-git-')); });
afterEach(async () => {
  vi.unstubAllEnvs();
  // Only this test's allocated temporary directory; never development data.
  await rm(root, { recursive: true, force: true });
});

async function fixture(runner: GitRunner = runGit) {
  const git = new LocalGitService(join(root, 'data'), undefined, runner);
  const workspaceId = randomUUID(), taskId = randomUUID(), agentInstanceId = randomUUID(), runId = randomUUID();
  const repo = await git.ensureRepository(workspaceId);
  const command = async (...args: string[]) => (await runGit(['--git-dir', repo.repositoryPath, ...args])).stdout.trim();
  const checkpoint = (files: Array<{ path: string; text: string }>) => git.checkpoint({ workspaceId, taskId, files });
  const apply = (changes: TextChange[], allowedWritePaths = changes.map((change) => change.path)) =>
    git.applyWorkerChanges({ workspaceId, agentInstanceId, allowedWritePaths, changes });
  const read = (path: string, commitSha?: string) => git.readText({
    workspaceId, target: commitSha ? { kind: 'commit', commitSha } : { kind: 'worker', agentInstanceId },
    path, allowedPaths: [path],
  });
  const worker = (baseSha = repo.mainSha) => git.createWorker({ workspaceId, agentInstanceId, baseSha });
  return { git, workspaceId, taskId, agentInstanceId, runId, repo, command, checkpoint, apply, read, worker };
}

/** Fixture-only plumbing can manufacture objects the product must reject. */
async function rawCommit(repo: string, base: string, path: string, bytes: Buffer, mode = '100644') {
  const prefix = ['--git-dir', repo];
  const indexFile = join(root, `fixture-index-${randomUUID()}`);
  const hash = mode === '160000' ? base : (await runGit([...prefix, 'hash-object', '-w', '--stdin'], { input: bytes })).stdout.trim();
  await runGit([...prefix, 'read-tree', base], { indexFile });
  await runGit([...prefix, 'update-index', '-z', '--index-info'], { indexFile, input: `${mode} ${hash}\t${path}\0` });
  const tree = (await runGit([...prefix, 'write-tree'], { indexFile })).stdout.trim();
  return (await runGit([...prefix, 'commit-tree', tree, '-p', base, '-m', 'Test fixture'])).stdout.trim();
}

const unsafePaths = [
  '../documents/a.md', '/documents/a.md', 'C:\\documents\\a.md', '\\\\server\\documents\\a.md',
  'documents/../code/a.ts', 'documents\\..\\code/a.ts', 'documents//a.md', 'documents/./a.md',
  'documents/.git/config.md', 'documents/.GIT/config.md', 'documents/.gitattributes', 'documents/.gitmodules',
  'documents/hooks/a.md', 'logs/task.md', 'documents/a.zip', 'documents/a.md\0', 'documents/a\nb.md',
  'documents/a.md:stream', 'documents/NUL.md', 'documents/com1.txt', 'documents/a./b.md',
  'documents/a /b.md', 'documents/a?.md', 'documents/a*.md', 'documents/PROGRA~1/a.md',
];

describe('portable text validation', () => {
  it.each(unsafePaths)('rejects %j', (path) => expect(() => filePath(path)).toThrow(expect.objectContaining({ code: 'INVALID_PATH' })));
  it('normalizes backslashes and preserves Unicode, BOM, empty text, and exact byte limits', () => {
    expect(filePath('documents\\nested\\hello.md')).toBe('documents/nested/hello.md');
    expect(textBytes('')).toEqual(Buffer.alloc(0));
    expect(textBytes('\uFEFFhéllo 🌲\r\n').toString()).toBe('\uFEFFhéllo 🌲\r\n');
    expect(textBytes('x'.repeat(MAX_TEXT_FILE_BYTES))).toHaveLength(MAX_TEXT_FILE_BYTES);
    for (const text of ['\0', '\ud800', '\udfff', 'é'.repeat(MAX_TEXT_FILE_BYTES)]) {
      expect(() => textBytes(text)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
  });
});

describe('managed branches and exact checkpoints', () => {
  it('creates correct branches, worktrees, immutable bases and clean multi-file checkpoints', async () => {
    const f = await fixture();
    const draft = await f.git.createDraft({ workspaceId: f.workspaceId, taskId: f.taskId });
    expect(draft).toEqual({ branch: `human/${f.taskId}` });
    const first = await f.checkpoint([{ path: 'documents/a.md', text: 'one' }, { path: 'code/a.ts', text: '' }]);
    const worker = await f.worker(first.commitSha);
    const result = await f.git.createResult({ workspaceId: f.workspaceId, runId: f.runId, baseSha: first.commitSha });
    expect(worker).toEqual({ branch: `agents/${f.agentInstanceId}`, worktreePath: join(root, 'data', 'worktrees', f.workspaceId, 'agents', f.agentInstanceId) });
    expect(result.worktreePath).toBe(join(root, 'data', 'worktrees', f.workspaceId, 'results', f.runId));
    expect(await f.command('rev-parse', `refs/app/bases/agents/${f.agentInstanceId}`)).toBe(first.commitSha);
    expect(await f.command('rev-parse', `refs/app/bases/human/${f.taskId}`)).toBe(f.repo.mainSha);
    expect(await f.command('rev-parse', result.branch)).toBe(first.commitSha);
    const next = await f.checkpoint([{ path: 'documents/a.md', text: 'two' }]);
    expect(await f.command('show', `${next.commitSha}:code/a.ts`)).toBe('');
    expect(await f.command('rev-parse', 'main')).toBe(f.repo.mainSha);
    const path = join(root, 'data', 'worktrees', f.workspaceId, 'human', f.taskId);
    expect((await runGit(['-C', path, 'status', '--porcelain'])).stdout).toBe('');
    expect(await readFile(join(path, 'documents/a.md'), 'utf8')).toBe('two');
    expect(await f.command('show', '-s', '--format=%an <%ae>%n%s', next.commitSha)).toBe(`Workspace Server <workspace@localhost>\nCheckpoint human draft ${f.taskId}`);
  });

  it('preserves draft lineage after main advances and reuses work across restart', async () => {
    const f = await fixture();
    const first = await f.checkpoint([{ path: 'documents/a.md', text: 'saved' }]);
    await runGit(['--git-dir', f.repo.repositoryPath, 'update-ref', 'refs/heads/main', first.commitSha, f.repo.mainSha]);
    const next = await f.checkpoint([{ path: 'documents/a.md', text: 'draft' }]);
    const restarted = new LocalGitService(join(root, 'data'));
    await restarted.createDraft({ workspaceId: f.workspaceId.toUpperCase(), taskId: f.taskId.toUpperCase() });
    expect(await f.command('rev-parse', `human/${f.taskId}`)).toBe(next.commitSha);
    expect(await f.command('rev-parse', `refs/app/bases/human/${f.taskId}`)).toBe(f.repo.mainSha);
    expect(await f.command('rev-parse', 'main')).toBe(first.commitSha);
  });

  it('recreates missing worker/result worktrees while preserving branch history and bases', async () => {
    const f = await fixture();
    const worker = await f.worker();
    const changed = await f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'saved' }]);
    // Move the exact test-owned worktree aside to simulate a missing projection.
    await rename(worker.worktreePath, join(root, 'saved-worker'));
    const restarted = new LocalGitService(join(root, 'data'));
    expect(await restarted.createWorker({ workspaceId: f.workspaceId, agentInstanceId: f.agentInstanceId, baseSha: f.repo.mainSha })).toEqual(worker);
    expect(await readFile(join(worker.worktreePath, 'code/a.ts'), 'utf8')).toBe('saved');
    expect(await f.command('rev-parse', worker.branch)).toBe(changed.commitSha);
    const result = await f.git.createResult({ workspaceId: f.workspaceId, runId: f.runId, baseSha: changed.commitSha });
    await rename(result.worktreePath, join(root, 'saved-result'));
    expect(await f.git.createResult({ workspaceId: f.workspaceId, runId: f.runId, baseSha: changed.commitSha })).toEqual(result);
  });

  it('serializes repeated creation across UUID casing in multiple contention rounds', async () => {
    const f = await fixture();
    for (let round = 0; round < 3; round++) {
      const id = randomUUID();
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => f.git.createWorker({
        workspaceId: i % 2 ? f.workspaceId.toUpperCase() : f.workspaceId,
        agentInstanceId: i % 2 ? id.toUpperCase() : id, baseSha: f.repo.mainSha,
      })));
      for (const result of results) expect(result).toEqual(results[0]);
      expect(await f.command('rev-list', '--count', `agents/${id}`)).toBe('1');
    }
  }, 60_000);

  it('rejects base changes, foreign/missing objects, blob bases, and malformed IDs before mutation', async () => {
    const f = await fixture();
    await f.worker();
    const changed = await f.checkpoint([{ path: 'documents/a.md', text: 'other' }]);
    await expect(f.worker(changed.commitSha)).rejects.toMatchObject({ code: 'INPUT_CONFLICT' });
    await f.git.createResult({ workspaceId: f.workspaceId, runId: f.runId, baseSha: f.repo.mainSha });
    await expect(f.git.createResult({ workspaceId: f.workspaceId, runId: f.runId, baseSha: changed.commitSha })).rejects.toMatchObject({ code: 'INPUT_CONFLICT' });
    const foreign = await fixture();
    const foreignCommit = await foreign.checkpoint([{ path: 'documents/foreign.md', text: 'foreign' }]);
    for (const baseSha of ['f'.repeat(40), foreignCommit.commitSha, blobHash(Buffer.from('other')), '--help']) {
      await expect(f.git.createWorker({ workspaceId: f.workspaceId, agentInstanceId: randomUUID(), baseSha })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    const fresh = new LocalGitService(join(root, 'absent'));
    await expect(fresh.createDraft({ workspaceId: f.workspaceId, taskId: '../escape' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readdir(root)).not.toContain('absent');
  });

  it('preserves occupied targets, junction targets, and corrupt registrations', async () => {
    const f = await fixture();
    const parent = join(root, 'data', 'worktrees', f.workspaceId, 'agents');
    await mkdir(join(parent, f.agentInstanceId), { recursive: true });
    await writeFile(join(parent, f.agentInstanceId, 'keep.txt'), 'keep');
    await expect(f.worker()).rejects.toMatchObject({ code: 'OCCUPIED_WORKTREE' });
    expect(await readFile(join(parent, f.agentInstanceId, 'keep.txt'), 'utf8')).toBe('keep');
    const target = join(root, 'outside'); await mkdir(target);
    const linkedId = randomUUID();
    await symlink(target, join(parent, linkedId), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.git.createWorker({ workspaceId: f.workspaceId, agentInstanceId: linkedId, baseSha: f.repo.mainSha })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(await readdir(target)).toEqual([]);
    const a = await f.git.createWorker({ workspaceId: f.workspaceId, agentInstanceId: randomUUID(), baseSha: f.repo.mainSha });
    const bId = randomUUID();
    const b = await f.git.createWorker({ workspaceId: f.workspaceId, agentInstanceId: bId, baseSha: f.repo.mainSha });
    // Git marks this file hidden on Windows, where opening an existing hidden
    // file with 'w' fails. r+ can replace the same-length registration safely.
    await writeFile(join(b.worktreePath, '.git'), await readFile(join(a.worktreePath, '.git')), { flag: 'r+' });
    await expect(f.git.createWorker({ workspaceId: f.workspaceId, agentInstanceId: bId, baseSha: f.repo.mainSha })).rejects.toMatchObject({ code: 'INVALID_WORKTREE' });
  });
});

describe('scoped reads and worker batches', () => {
  it('commits create/replace/delete batches and keeps every other branch isolated', async () => {
    const f = await fixture();
    const draft = await f.checkpoint([{ path: 'documents/a.md', text: 'original' }]);
    const worker = await f.worker(draft.commitSha);
    const otherId = randomUUID();
    await f.git.createWorker({ workspaceId: f.workspaceId, agentInstanceId: otherId, baseSha: draft.commitSha });
    await f.git.createResult({ workspaceId: f.workspaceId, runId: f.runId, baseSha: draft.commitSha });
    const text = '\uFEFFhéllo 🌲\r\n';
    const changed = await f.apply([
      { path: 'documents/a.md', expectedHash: blobHash(Buffer.from('original')), newText: text },
      { path: 'code/a.ts', expectedHash: null, newText: '' },
    ]);
    expect(changed.changedPaths).toEqual(['code/a.ts', 'documents/a.md']);
    expect(await f.read('documents\\a.md')).toEqual({ path: 'documents/a.md', text, hash: blobHash(Buffer.from(text)) });
    expect(await f.read('code/a.ts')).toEqual({ path: 'code/a.ts', text: '', hash: blobHash(Buffer.alloc(0)) });
    expect((await f.read('documents/a.md', draft.commitSha)).text).toBe('original');
    expect(await f.read('documents/missing.md')).toEqual({ path: 'documents/missing.md', text: null, hash: null });
    const deleted = await f.apply([{ path: 'documents/a.md', expectedHash: blobHash(Buffer.from(text)), newText: null }]);
    expect(deleted.changedPaths).toEqual(['documents/a.md']);
    expect((await f.read('documents/a.md')).hash).toBeNull();
    expect(await f.command('rev-parse', 'main')).toBe(f.repo.mainSha);
    for (const branch of [`human/${f.taskId}`, `results/${f.runId}`, `agents/${otherId}`]) {
      expect(await f.command('rev-parse', branch)).toBe(draft.commitSha);
    }
    expect((await runGit(['-C', worker.worktreePath, 'status', '--porcelain'])).stdout).toBe('');
    expect(await f.command('rev-list', '--count', `${draft.commitSha}..${deleted.commitSha}`)).toBe('2');
  });

  it('keeps all files and the prior checkpoint after any invalid member or stale hash', async () => {
    const f = await fixture(); await f.worker();
    const first = await f.apply([{ path: 'documents/a.md', expectedHash: null, newText: 'saved' }]);
    const good = { path: 'documents/b.md', expectedHash: null, newText: 'new' };
    for (const [bad, code] of [
      [{ path: 'documents/a.md', expectedHash: null, newText: 'replace' }, 'FILE_VERSION_CHANGED'],
      [{ path: 'documents/a.md', expectedHash: 'f'.repeat(40), newText: null }, 'FILE_VERSION_CHANGED'],
      [{ path: 'documents/missing.md', expectedHash: 'f'.repeat(40), newText: null }, 'FILE_VERSION_CHANGED'],
      [{ path: 'documents/missing.md', expectedHash: null, newText: null }, 'VALIDATION_FAILED'],
      [{ path: 'documents/c.md', expectedHash: null, newText: '\0' }, 'VALIDATION_FAILED'],
      [{ path: 'documents/c.md', expectedHash: null, newText: 'x'.repeat(MAX_TEXT_FILE_BYTES + 1) }, 'VALIDATION_FAILED'],
      [{ path: 'documents/c.zip', expectedHash: null, newText: 'bad' }, 'INVALID_PATH'],
    ] as const) {
      await expect(f.apply([good, bad])).rejects.toMatchObject({ code });
      expect(await f.command('rev-parse', `agents/${f.agentInstanceId}`)).toBe(first.commitSha);
      expect((await f.read('documents/b.md')).hash).toBeNull();
    }
    await expect(f.apply([good, { ...good, path: 'documents\\b.md' }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(f.apply([{ path: 'documents/a.md', expectedHash: null, newText: 'stale' }])).rejects.toMatchObject({
      code: 'FILE_VERSION_CHANGED', details: { path: 'documents/a.md', currentHash: blobHash(Buffer.from('saved')) },
    });
  }, 60_000);

  it('enforces exact scopes and validates read allow-lists at runtime', async () => {
    const f = await fixture(); await f.worker();
    const changes = [{ path: 'code/b.ts', expectedHash: null, newText: 'bad' }];
    await expect(f.apply(changes, ['code/a.ts'])).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(f.apply(changes, ['code'])).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(f.git.readText({ workspaceId: f.workspaceId, target: { kind: 'worker', agentInstanceId: f.agentInstanceId }, path: 'code/b.ts', allowedPaths: ['code/a.ts'] })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(f.git.readText({ workspaceId: f.workspaceId, target: { kind: 'commit', commitSha: f.repo.mainSha }, path: 'code/b.ts', allowedPaths: ['code/b.ts', '../escape.md'] })).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('round-trips a full 1 MiB blob and keeps human checkpoints unchanged after validation failure', async () => {
    const f = await fixture(); await f.worker();
    const large = 'é'.repeat(MAX_TEXT_FILE_BYTES / 2);
    await f.apply([{ path: 'documents/large.md', expectedHash: null, newText: large }]);
    expect(await f.read('documents/large.md')).toEqual({ path: 'documents/large.md', text: large, hash: blobHash(Buffer.from(large)) });
    const draft = await f.checkpoint([{ path: 'documents/a.md', text: 'before' }]);
    await expect(f.checkpoint([{ path: 'documents/a.md', text: 'after' }, { path: 'code/b.ts', text: '\0' }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await f.command('rev-parse', `human/${f.taskId}`)).toBe(draft.commitSha);
    expect(await readFile(join(root, 'data', 'worktrees', f.workspaceId, 'human', f.taskId, 'documents/a.md'), 'utf8')).toBe('before');
  });

  it('allows another workspace to progress while this workspace has a Git mutation paused', async () => {
    let paused = false;
    let signal!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => { signal = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const f = await fixture(async (args, options) => {
      if (paused && args.includes('commit-tree')) { signal(); await gate; }
      return runGit(args, options);
    });
    await f.worker();
    const otherWorkspace = randomUUID(), otherAgent = randomUUID();
    const other = await f.git.initialize(otherWorkspace);
    await f.git.createWorker({ workspaceId: otherWorkspace, agentInstanceId: otherAgent, baseSha: other.mainSha });
    paused = true;
    const first = f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'one' }]);
    try {
      await entered;
      // Creation takes the other workspace's lock and needs no commit-tree.
      await expect(f.git.createWorker({ workspaceId: otherWorkspace, agentInstanceId: randomUUID(), baseSha: other.mainSha })).resolves.toHaveProperty('branch');
      await expect(f.git.readText({ workspaceId: otherWorkspace, target: { kind: 'worker', agentInstanceId: f.agentInstanceId }, path: 'code/a.ts', allowedPaths: ['code/a.ts'] })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally { release(); }
    await first;
    const otherRepo = join(root, 'data', 'repos', `${otherWorkspace}.git`);
    expect((await runGit(['--git-dir', otherRepo, 'rev-parse', `agents/${otherAgent}`])).stdout.trim()).toBe(other.mainSha);
  });

  it('reads committed bytes through dirty projections and preserves unknown disk changes', async () => {
    const f = await fixture(); const worker = await f.worker();
    const saved = await f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'saved' }]);
    await writeFile(join(worker.worktreePath, 'code/a.ts'), 'external edit');
    expect((await f.read('code/a.ts')).text).toBe('saved');
    await expect(f.apply([{ path: 'code/b.ts', expectedHash: null, newText: 'new' }])).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    expect(await readFile(join(worker.worktreePath, 'code/a.ts'), 'utf8')).toBe('external edit');
    expect(await f.command('rev-parse', worker.branch)).toBe(saved.commitSha);
  });

  it('preserves staged local edits instead of treating the Git index as a saved checkpoint', async () => {
    const f = await fixture(); const worker = await f.worker();
    const saved = await f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'saved' }]);
    await writeFile(join(worker.worktreePath, 'code/a.ts'), 'valuable staged edit');
    await runGit(['-C', worker.worktreePath, 'add', '--', 'code/a.ts']);
    await expect(f.apply([{ path: 'code/b.ts', expectedHash: null, newText: 'new' }])).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    expect(await readFile(join(worker.worktreePath, 'code/a.ts'), 'utf8')).toBe('valuable staged edit');
    expect((await runGit(['-C', worker.worktreePath, 'show', ':code/a.ts'])).stdout).toBe('valuable staged edit');
    expect(await f.command('rev-parse', worker.branch)).toBe(saved.commitSha);
    // Even if worktree bytes match HEAD, an independently staged version is
    // still valuable and must not be silently replaced by read-tree.
    await writeFile(join(worker.worktreePath, 'code/a.ts'), 'saved');
    await expect(f.worker()).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    expect((await runGit(['-C', worker.worktreePath, 'show', ':code/a.ts'])).stdout).toBe('valuable staged edit');
  });

  it('returns the existing head for unchanged content and empty batches', async () => {
    const f = await fixture(); await f.worker();
    const first = await f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'same' }]);
    expect(await f.apply([{ path: 'code/a.ts', expectedHash: blobHash(Buffer.from('same')), newText: 'same' }])).toEqual({ commitSha: first.commitSha, changedPaths: [] });
    expect(await f.apply([])).toEqual({ commitSha: first.commitSha, changedPaths: [] });
    const draft = await f.checkpoint([{ path: 'documents/a.md', text: 'same' }]);
    expect(await f.checkpoint([{ path: 'documents/a.md', text: 'same' }])).toEqual(draft);
    expect(await f.checkpoint([])).toEqual(draft);
  });

  it('checks hashes under the lock so one concurrent replacement wins in each round', async () => {
    const f = await fixture(); await f.worker();
    await f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'initial' }]);
    for (let round = 0; round < 3; round++) {
      const expectedHash = (await f.read('code/a.ts')).hash;
      const results = await Promise.allSettled([0, 1].map((i) => f.apply([{ path: 'code/a.ts', expectedHash, newText: `round ${round}, contender ${i}` }])));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'FILE_VERSION_CHANGED' });
    }
  }, 60_000);

  it.each([
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), '100644'],
    ['NUL', Buffer.from([0]), '100644'],
    ['oversized', Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 65), '100644'],
    ['symlink', Buffer.from('../../outside'), '120000'],
    ['submodule', Buffer.alloc(0), '160000'],
  ])('rejects %s Git entries without materializing them', async (_name, bytes, mode) => {
    const f = await fixture();
    const sha = await rawCommit(f.repo.repositoryPath, f.repo.mainSha, 'documents/a.md', bytes as Buffer, mode as string);
    const code = mode === '100644' ? 'VALIDATION_FAILED' : 'INVALID_PATH';
    await expect(f.read('documents/a.md', sha)).rejects.toMatchObject({ code });
    await expect(f.worker(sha)).rejects.toMatchObject({ code });
    expect(await f.command('for-each-ref', '--format=%(refname)', 'refs/heads/agents/')).toBe('');
  });

  it('rejects filesystem links, special directory targets, aliases and path collisions', async () => {
    const f = await fixture(); const worker = await f.worker();
    const outside = join(root, 'outside'); await mkdir(outside);
    await symlink(outside, join(worker.worktreePath, 'documents'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.read('documents/a.md')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(f.apply([{ path: 'documents/a.md', expectedHash: null, newText: 'bad' }])).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(await readdir(outside)).toEqual([]);
    const g = await fixture(); const safe = await g.worker();
    await mkdir(join(safe.worktreePath, 'code', 'directory.ts'), { recursive: true });
    await expect(g.read('code/directory.ts')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(g.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'a' }, { path: 'code/A.ts', expectedHash: null, newText: 'b' }])).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await writeFile(join(root, 'valuable.md'), 'valuable');
    await link(join(root, 'valuable.md'), join(safe.worktreePath, 'code', 'hard.md'));
    await expect(g.read('code/hard.md')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(await readFile(join(root, 'valuable.md'), 'utf8')).toBe('valuable');
  });
});

describe('checkpoint failure boundaries and trusted execution', () => {
  it('rejects a failed compare-and-swap without overwriting the intervening branch head', async () => {
    let raced = false, competing = '', repository = '';
    const f = await fixture(async (args, options) => {
      if (raced && args.includes('update-ref') && args.some((arg) => arg.startsWith('refs/heads/agents/'))) {
        const position = args.indexOf('update-ref');
        const ref = args[position + 1]!, expected = args[position + 3]!;
        const tree = (await runGit(['--git-dir', repository, 'rev-parse', `${expected}^{tree}`])).stdout.trim();
        competing = (await runGit(['--git-dir', repository, 'commit-tree', tree, '-p', expected, '-m', 'Intervening checkpoint'])).stdout.trim();
        await runGit(['--git-dir', repository, 'update-ref', ref, competing, expected]);
      }
      return runGit(args, options);
    });
    repository = f.repo.repositoryPath;
    const worker = await f.worker(); raced = true;
    await expect(f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'candidate' }])).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(await f.command('rev-parse', worker.branch)).toBe(competing);
    expect(await readdir(worker.worktreePath)).toEqual(['.git']);
    expect(await f.command('rev-parse', 'main')).toBe(f.repo.mainSha);
  });

  it('repairs creation interrupted after publishing refs but before adding the worktree', async () => {
    let fail = true;
    const f = await fixture(async (args, options) => {
      if (fail && args.includes('worktree') && args.includes('add')) throw new GitRuntimeError('INJECTED_FAILURE');
      return runGit(args, options);
    });
    await expect(f.worker()).rejects.toMatchObject({ code: 'INJECTED_FAILURE' });
    expect(await f.command('rev-parse', `agents/${f.agentInstanceId}`)).toBe(f.repo.mainSha);
    expect(await f.command('rev-parse', `refs/app/bases/agents/${f.agentInstanceId}`)).toBe(f.repo.mainSha);
    fail = false;
    const worker = await f.worker();
    expect((await runGit(['-C', worker.worktreePath, 'status', '--porcelain'])).stdout).toBe('');
  });

  it('preserves all refs and projection bytes if candidate construction fails; retry succeeds', async () => {
    let fail = false;
    const f = await fixture(async (args, options) => {
      if (fail && args.includes('commit-tree')) throw new GitRuntimeError('INJECTED_FAILURE');
      return runGit(args, options);
    });
    const worker = await f.worker();
    const changes = [{ path: 'code/a.ts', expectedHash: null, newText: 'one' }, { path: 'documents/a.md', expectedHash: null, newText: 'two' }];
    fail = true;
    await expect(f.apply(changes)).rejects.toMatchObject({ code: 'INJECTED_FAILURE' });
    expect(await f.command('rev-parse', worker.branch)).toBe(f.repo.mainSha);
    expect(await readdir(worker.worktreePath)).toEqual(['.git']);
    fail = false;
    expect((await f.apply(changes)).changedPaths).toHaveLength(2);
  });

  it('retains a committed batch after projection failure and repairs it after restart', async () => {
    let fail = false, advanced = false;
    const f = await fixture(async (args, options) => {
      if (fail && args.includes('update-ref') && !args.includes('--stdin')) advanced = true;
      if (fail && advanced && args.includes('read-tree')) throw new GitRuntimeError('INJECTED_FAILURE');
      return runGit(args, options);
    });
    const worker = await f.worker();
    fail = true;
    await expect(f.apply([{ path: 'code/a.ts', expectedHash: null, newText: 'committed' }])).rejects.toMatchObject({ code: 'WORKTREE_SYNC_FAILED' });
    const head = await f.command('rev-parse', worker.branch);
    expect(head).not.toBe(f.repo.mainSha);
    expect(await f.command('show', `${head}:code/a.ts`)).toBe('committed');
    const restarted = new LocalGitService(join(root, 'data'));
    await restarted.createWorker({ workspaceId: f.workspaceId, agentInstanceId: f.agentInstanceId, baseSha: f.repo.mainSha });
    expect(await f.command('rev-parse', worker.branch)).toBe(head);
    expect((await runGit(['-C', worker.worktreePath, 'status', '--porcelain'])).stdout).toBe('');
    expect(await readFile(join(worker.worktreePath, 'code/a.ts'), 'utf8')).toBe('committed');
  });

  it('redacts unexpected filesystem failures without exposing roots or causes', async () => {
    let fail = false;
    const f = await fixture(async (args, options) => {
      if (fail) throw new Error(`private secret ${root}`);
      return runGit(args, options);
    });
    await f.worker(); fail = true;
    const error = await f.apply([]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitRuntimeError);
    expect(String(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('ignores hostile Git environment, hooks and filters and preserves exact CRLF bytes', async () => {
    const f = await fixture();
    await mkdir(join(f.repo.repositoryPath, 'hooks'), { recursive: true });
    for (const name of ['reference-transaction', 'post-checkout']) {
      const hook = join(f.repo.repositoryPath, 'hooks', name);
      await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
    }
    await f.command('config', 'core.hooksPath', join(f.repo.repositoryPath, 'hooks'));
    await f.command('config', 'core.autocrlf', 'true');
    await f.command('config', 'filter.poison.clean', 'command-that-must-never-execute');
    await f.command('config', 'filter.poison.smudge', 'command-that-must-never-execute');
    await f.command('config', 'filter.poison.required', 'true');
    await mkdir(join(f.repo.repositoryPath, 'info'), { recursive: true });
    await writeFile(join(f.repo.repositoryPath, 'info', 'attributes'), '*.ts filter=poison\n');
    vi.stubEnv('GIT_INDEX_FILE', join(root, 'outside-index'));
    vi.stubEnv('GIT_WORK_TREE', root);
    const worker = await f.worker();
    const text = 'line one\r\nline two\r\n';
    await f.apply([{ path: 'code/a.ts', expectedHash: null, newText: text }]);
    expect((await f.read('code/a.ts')).text).toBe(text);
    expect(await readFile(join(worker.worktreePath, 'code/a.ts'), 'utf8')).toBe(text);
    expect(await readdir(root)).not.toContain('outside-index');
  });
});
