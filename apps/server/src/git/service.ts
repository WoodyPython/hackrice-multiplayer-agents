import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { shaSchema, type GitService } from '@app/contracts';
import { GitRuntimeError, runGit, type GitRunner } from './command.js';
import { canonicalWorkspaceId, WorkspaceOperationLock } from './lock.js';

export interface Repository {
  /** Backend-only; never serialize into an API response or model context. */
  repositoryPath: string;
  mainSha: string;
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new GitRuntimeError('INVALID_DIRECTORY');
}

/** Partial GitService implementation; D02 and subsequent tickets add its other methods. */
export class LocalGitService implements Pick<GitService, 'initialize'> {
  private readonly root: string;
  private preparation?: Promise<void>;

  constructor(
    gitDataRoot: string,
    private readonly locks = new WorkspaceOperationLock(),
    private readonly git: GitRunner = runGit,
  ) {
    this.root = resolve(gitDataRoot);
  }

  async prepare(): Promise<void> {
    if (!this.preparation) {
      this.preparation = this.prepareRoot().catch((error: unknown) => {
        this.preparation = undefined;
        throw error instanceof GitRuntimeError ? error : new GitRuntimeError('ROOT_UNAVAILABLE');
      });
    }
    return this.preparation;
  }

  private async prepareRoot(): Promise<void> {
    await directory(this.root);
    for (const name of ['repos', 'worktrees']) {
      const path = join(this.root, name);
      await directory(path);
      // mkdir on an existing read-only directory can succeed; actually probe writes.
      const probe = await mkdtemp(join(path, '.write-check-'));
      try {
        const handle = await open(join(probe, 'probe'), 'wx');
        await handle.close();
      } finally {
        await rm(probe, { recursive: true, force: true });
      }
    }
    await this.git(['--version']);
  }

  async initialize(workspaceId: string): Promise<{ mainSha: string }> {
    const { mainSha } = await this.ensureRepository(workspaceId);
    return { mainSha };
  }

  async ensureRepository(workspaceId: string): Promise<Repository> {
    return this.withRepository(workspaceId, async (repository) => repository);
  }

  /**
   * Every future Git access uses this barrier, including first-access repair.
   * The callback already holds the lock: do not call initialize/ensure inside it.
   * Callers are trusted backend services that have resolved the workspace record.
   */
  async withRepository<T>(workspaceId: string, operation: (repo: Repository) => Promise<T>): Promise<T> {
    const id = canonicalWorkspaceId(workspaceId);
    return this.locks.run(id, async () => {
      await this.prepare();
      let repository: Repository;
      try {
        repository = await this.ensureLocked(id);
      } catch (error) {
        throw error instanceof GitRuntimeError ? error : new GitRuntimeError('REPOSITORY_UNAVAILABLE');
      }
      return operation(repository);
    });
  }

  private async ensureLocked(id: string): Promise<Repository> {
    const repos = join(this.root, 'repos');
    await directory(repos);
    const repositoryPath = join(repos, `${id}.git`);
    const existing = await lstat(repositoryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!existing) {
      // Publish only a complete repository. A crash during init leaves a hidden
      // staging directory, never a half-initialized canonical repository.
      const staging = await mkdtemp(join(repos, `.${id}-init-`));
      try {
        await this.git(['init', '--bare', '--initial-branch=main', '--object-format=sha1', '--template=', staging]);
        const mainSha = await this.ensureMain(staging);
        await rename(staging, repositoryPath);
        return { repositoryPath, mainSha };
      } finally {
        // This exact mkdtemp path is the only repository directory we remove.
        await rm(staging, { recursive: true, force: true });
      }
    }
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new GitRuntimeError('INVALID_REPOSITORY');
    // Resolve to check the canonical target even when the configured root has
    // an OS-managed parent junction. The workspace itself must never be a link.
    if (await realpath(repositoryPath) !== join(await realpath(repos), `${id}.git`)) {
      throw new GitRuntimeError('INVALID_REPOSITORY');
    }
    const bare = await this.git(['--git-dir', repositoryPath, 'rev-parse', '--is-bare-repository']);
    if (bare.stdout.trim() !== 'true') throw new GitRuntimeError('INVALID_REPOSITORY');
    const head = await this.git(['--git-dir', repositoryPath, 'symbolic-ref', 'HEAD']);
    if (head.stdout.trim() !== 'refs/heads/main') throw new GitRuntimeError('INVALID_HEAD');
    return { repositoryPath, mainSha: await this.ensureMain(repositoryPath) };
  }

  private async ensureMain(path: string): Promise<string> {
    const git = (args: string[], options?: Parameters<GitRunner>[1]) =>
      this.git(['--git-dir', path, ...args], options);
    // show-ref distinguishes a missing ref from a present but corrupt object.
    const present = await git(['show-ref', '--verify', '--quiet', 'refs/heads/main'], { allowedExitCodes: [1] });
    if (present.exitCode === 0) {
      return shaSchema.parse((await git(['rev-parse', '--verify', 'refs/heads/main^{commit}'])).stdout.trim());
    }
    // A malformed loose main ref must not be mistaken for an absent one.
    const heads = await readdir(join(path, 'refs', 'heads'));
    if (heads.includes('main')) throw new GitRuntimeError('INVALID_MAIN');
    const tree = (await git(['mktree'], { input: '' })).stdout.trim();
    const commit = shaSchema.parse((await git(['commit-tree', tree, '-m', 'Initialize workspace'])).stdout.trim());
    await git(['update-ref', 'refs/heads/main', commit, '0'.repeat(40)]);
    return commit;
  }
}
