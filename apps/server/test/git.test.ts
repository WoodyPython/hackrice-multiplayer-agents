import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitRuntimeError, runGit, type GitRunner } from '../src/git/command.js';
import { GitWorkspaceLifecycleHook } from '../src/git/lifecycle.js';
import { WorkspaceOperationLock } from '../src/git/lock.js';
import { LocalGitService } from '../src/git/service.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'd01-git-')); });
afterEach(async () => {
  vi.unstubAllEnvs();
  // Only remove this test's freshly allocated temporary directory.
  await rm(root, { recursive: true, force: true });
});

describe('persistent workspace repositories', () => {
  it('creates one empty, server-authored main commit in a bare SHA-1 repository', async () => {
    const git = new LocalGitService(root);
    const id = randomUUID();
    const { mainSha } = await git.initialize(id);
    expect(mainSha).toMatch(/^[a-f0-9]{40}$/);
    const path = join(root, 'repos', `${id}.git`);
    const read = async (...args: string[]) => (await runGit(['--git-dir', path, ...args])).stdout.trim();
    expect(await read('rev-parse', '--is-bare-repository')).toBe('true');
    expect(await read('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(await read('show', '-s', '--format=%an <%ae>%n%cn <%ce>%n%P%n%s', 'main')).toBe(
      'Workspace Server <workspace@localhost>\nWorkspace Server <workspace@localhost>\n\nInitialize workspace',
    );
    expect(await read('ls-tree', '-r', 'main')).toBe('');
    expect(await readdir(join(root, 'repos'))).toEqual([`${id}.git`]);
    expect(await readdir(join(root, 'worktrees'))).toEqual([]);
  });

  it('serializes concurrent creation, including differently cased UUIDs', async () => {
    const git = new LocalGitService(root);
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => git.initialize(i % 2 ? id : id.toUpperCase())));
    expect(new Set(results.map((result) => result.mainSha)).size).toBe(1);
    expect(await git.initialize(id)).toEqual(results[0]);
    const count = await runGit(['--git-dir', join(root, 'repos', `${id}.git`), 'rev-list', '--count', 'main']);
    expect(count.stdout.trim()).toBe('1');
  });

  it('preserves later main history across a fresh service instance', async () => {
    const id = randomUUID();
    const git = new LocalGitService(root);
    const { repositoryPath, mainSha } = await git.ensureRepository(id);
    const prefix = ['--git-dir', repositoryPath];
    const tree = (await runGit([...prefix, 'rev-parse', 'main^{tree}'])).stdout.trim();
    const next = (await runGit([...prefix, 'commit-tree', tree, '-p', mainSha, '-m', 'Approved history'])).stdout.trim();
    await runGit([...prefix, 'update-ref', 'refs/heads/main', next, mainSha]);
    expect(await new LocalGitService(root).initialize(id)).toEqual({ mainSha: next });
  });

  it('repairs a bare repository interrupted before main was created', async () => {
    const id = randomUUID();
    const git = new LocalGitService(root);
    await git.prepare();
    await runGit(['init', '--bare', '--initial-branch=main', join(root, 'repos', `${id}.git`)]);
    const initialized = await git.initialize(id);
    expect(initialized.mainSha).toMatch(/^[a-f0-9]{40}$/);
    expect(await git.initialize(id)).toEqual(initialized);
  });

  it('cleans only its staging directory after failed init and retries on first access', async () => {
    let fail = true;
    const runner: GitRunner = async (args, options) => {
      if (fail && args.includes('commit-tree')) throw new GitRuntimeError('COMMAND_FAILED');
      return runGit(args, options);
    };
    const git = new LocalGitService(root, undefined, runner);
    const id = randomUUID();
    await expect(git.initialize(id)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(await readdir(join(root, 'repos'))).toEqual([]);
    fail = false;
    expect((await git.ensureRepository(id)).mainSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it('rejects invalid identifiers before creating the data root', async () => {
    const path = join(root, 'must-not-exist');
    const git = new LocalGitService(path);
    for (const id of ['../outside', 'C:\\outside', '--bare', 'name', '']) {
      await expect(git.initialize(id)).rejects.toThrow();
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('preserves non-repositories, non-bare repositories, and malformed main refs', async () => {
    const git = new LocalGitService(root);
    await git.prepare();
    const id = randomUUID();
    const path = join(root, 'repos', `${id}.git`);
    await mkdir(path);
    await writeFile(join(path, 'keep.txt'), 'valuable');
    await expect(git.initialize(id)).rejects.toThrow(GitRuntimeError);
    expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('valuable');
    await runGit(['init', '--initial-branch=main', path]);
    await expect(git.initialize(id)).rejects.toThrow(GitRuntimeError);
    const other = randomUUID();
    const repo = await git.ensureRepository(other);
    await writeFile(join(repo.repositoryPath, 'refs', 'heads', 'main'), 'broken\n');
    await expect(git.initialize(other)).rejects.toThrow(GitRuntimeError);
    expect(await readFile(join(repo.repositoryPath, 'refs', 'heads', 'main'), 'utf8')).toBe('broken\n');
  });

  it('rejects repository junctions without writing into their target', async () => {
    const git = new LocalGitService(root);
    await git.prepare();
    const target = join(root, 'outside-repos');
    await mkdir(target);
    const id = randomUUID();
    await symlink(target, join(root, 'repos', `${id}.git`), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(git.initialize(id)).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    expect(await readdir(target)).toEqual([]);
  });

  it('ignores inherited Git redirection and identity settings', async () => {
    vi.stubEnv('GIT_DIR', join(root, 'wrong-repository'));
    vi.stubEnv('GIT_OBJECT_DIRECTORY', join(root, 'wrong-objects'));
    vi.stubEnv('GIT_AUTHOR_NAME', 'Personal Identity');
    const repo = await new LocalGitService(root).ensureRepository(randomUUID());
    expect((await runGit(['--git-dir', repo.repositoryPath, 'show', '-s', '--format=%an', 'main'])).stdout.trim()).toBe('Workspace Server');
    expect(await readdir(root)).toEqual(['repos', 'worktrees']);
  });

  it('redacts filesystem and child-process failures', async () => {
    const error = await runGit(['--git-dir', join(root, 'missing'), 'rev-parse', 'main']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitRuntimeError);
    expect(String(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain(root);
    const fileRoot = join(root, 'file');
    await writeFile(fileRoot, 'keep');
    await expect(new LocalGitService(fileRoot).prepare()).rejects.toMatchObject({ code: 'ROOT_UNAVAILABLE' });
  });
});

describe('workspace operation lock', () => {
  it('allows another workspace through while preserving same-workspace order after a failure', async () => {
    const lock = new WorkspaceOperationLock();
    const id = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const first = lock.run(id, async () => { events.push('first'); await gate; throw new Error('expected'); });
    const caught = first.catch(() => undefined);
    const second = lock.run(id, async () => { events.push('second'); });
    try {
      await lock.run(randomUUID(), async () => { events.push('other'); });
      expect(events).toEqual(['first', 'other']);
    } finally { release(); }
    await Promise.all([caught, second]);
    expect(events).toEqual(['first', 'other', 'second']);
  });
});

describe('workspace lifecycle hook', () => {
  it.each(['synchronous', 'asynchronous'])('contains a %s failure even when logging fails', async (mode) => {
    const report = vi.fn(() => { throw new Error('logger broken'); });
    const hook = new GitWorkspaceLifecycleHook({
      ensureRepository: () => {
        const error = new Error(`private path ${root}`);
        if (mode === 'synchronous') throw error;
        return Promise.reject(error);
      },
    }, report);
    const id = randomUUID();
    expect(hook.onWorkspaceCreated({ workspaceId: id })).toBeUndefined();
    await hook.drain();
    expect(report).toHaveBeenCalledWith({ workspaceId: id, code: 'REPOSITORY_UNAVAILABLE' });
  });

  it('coalesces hook and first-access initialization under the same lock', async () => {
    const git = new LocalGitService(root);
    const report = vi.fn();
    const hook = new GitWorkspaceLifecycleHook(git, report);
    const id = randomUUID();
    hook.onWorkspaceCreated({ workspaceId: id });
    hook.onWorkspaceCreated({ workspaceId: id });
    const result = await git.initialize(id);
    await hook.drain();
    expect(report).not.toHaveBeenCalled();
    expect(await git.initialize(id)).toEqual(result);
  });
});
