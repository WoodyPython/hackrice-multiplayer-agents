import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ApiError, applyWorkerChangesRequestSchema, applyWorkerChangesResultSchema,
  createDraftRequestSchema, createResultRequestSchema, createWorkerRequestSchema,
  gitBranchResultSchema, gitCheckpointRequestSchema, gitCheckpointResultSchema,
  gitReadTextRequestSchema, gitReadTextResultSchema, gitWorktreeResultSchema,
  shaSchema, type GitService, type WorkerCommitGuard,
} from '@app/contracts';
import { GitRuntimeError, runGit, type GitRunner } from './command.js';
import { canonicalWorkspaceId, WorkspaceOperationLock } from './lock.js';
import { filePath, invalidPath, pathSet, portablePaths, textBytes } from './files.js';
import { ManagedWorktrees } from './worktrees.js';

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError('VALIDATION_FAILED', 'Invalid Git operation request.');
  return result.data;
}

function uniquePaths(paths: string[]): void {
  if (new Set(paths).size !== paths.length) throw new ApiError('VALIDATION_FAILED', 'A batch contains duplicate paths.');
  portablePaths(paths);
}

export interface Repository {
  /** Backend-only; never serialize into an API response or model context. */
  repositoryPath: string;
  mainSha: string;
}

/** Valid only inside withDraftCapture's callback, which owns the workspace lock. */
export interface DraftGitCapture {
  readText(path: string): Promise<{ path: string; text: string | null; hash: string | null }>;
  checkpoint(files: Array<{ path: string; text: string }>): Promise<{ commitSha: string }>;
}

function checkpointFiles(files: Array<{ path: string; text: string }>) {
  const batch = files.map(({ path, text }) => { textBytes(text); return { path: filePath(path), text }; });
  uniquePaths(batch.map(({ path }) => path));
  return batch;
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new GitRuntimeError('INVALID_DIRECTORY');
}

/** D01/D02 GitService subset; integration/review/apply belong to later tickets. */
export class LocalGitService implements Pick<GitService,
  'initialize' | 'createDraft' | 'createWorker' | 'createResult' | 'checkpoint' | 'readText' | 'applyWorkerChanges'> {
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

  private async files<T>(workspaceId: string, operation: (files: ManagedWorktrees, repo: Repository) => Promise<T>): Promise<T> {
    return this.withRepository(workspaceId, async (repo) => {
      try {
        return await operation(new ManagedWorktrees(this.root, workspaceId.toLowerCase(), repo.repositoryPath, this.git), repo);
      } catch (error) {
        if (error instanceof ApiError || error instanceof GitRuntimeError) throw error;
        throw new GitRuntimeError('FILE_OPERATION_FAILED');
      }
    });
  }

  async createDraft(input: Parameters<GitService['createDraft']>[0]) {
    const value = parse(createDraftRequestSchema, input);
    return this.files(value.workspaceId, async (files, repo) => gitBranchResultSchema.parse(
      await files.ensure('human', value.taskId.toLowerCase(), repo.mainSha, true),
    ));
  }

  async createWorker(input: Parameters<GitService['createWorker']>[0]) {
    const value = parse(createWorkerRequestSchema, input);
    return this.files(value.workspaceId, async (files) => gitWorktreeResultSchema.parse(
      await files.ensure('agents', value.agentInstanceId.toLowerCase(), value.baseSha, true),
    ));
  }

  async createResult(input: Parameters<GitService['createResult']>[0]) {
    const value = parse(createResultRequestSchema, input);
    return this.files(value.workspaceId, async (files) => gitWorktreeResultSchema.parse(
      await files.ensure('results', value.runId.toLowerCase(), value.baseSha, true),
    ));
  }

  async readText(input: Parameters<GitService['readText']>[0]) {
    const value = parse(gitReadTextRequestSchema, input);
    const path = filePath(value.path);
    const allowed = pathSet(value.allowedPaths);
    portablePaths(allowed);
    if (!allowed.has(path)) invalidPath();
    return this.files(value.workspaceId, async (files) => gitReadTextResultSchema.parse(await files.read(value.target, path)));
  }

  async checkpoint(input: Parameters<GitService['checkpoint']>[0]) {
    const value = parse(gitCheckpointRequestSchema, input);
    const batch = checkpointFiles(value.files);
    return this.files(value.workspaceId, async (files, repo) => gitCheckpointResultSchema.parse(
      await files.checkpoint(value.taskId.toLowerCase(), repo.mainSha, batch),
    ));
  }

  async applyGuardedWorkerChanges(input: Parameters<GitService['applyWorkerChanges']>[0], guard: WorkerCommitGuard) {
    // Preserve trusted guard failures through files()'s filesystem redaction.
    let rejected = false;
    let rejection: unknown;
    try {
      return await this.applyWorkerChanges(input, async (checkpoint, publish) => {
        try { await guard(checkpoint, publish); }
        catch (error) { rejected = true; rejection = error; throw error; }
      });
    } catch (error) { throw rejected ? rejection : error; }
  }

  async applyWorkerChanges(input: Parameters<GitService['applyWorkerChanges']>[0], guard?: WorkerCommitGuard) {
    const value = parse(applyWorkerChangesRequestSchema, input);
    const allowed = pathSet(value.allowedWritePaths);
    portablePaths(allowed);
    const changes = value.changes.map((change) => {
      const path = filePath(change.path);
      if (!allowed.has(path)) invalidPath();
      if (change.newText === null && change.expectedHash === null) {
        throw new ApiError('VALIDATION_FAILED', 'Deletion requires an existing file hash.');
      }
      if (change.newText !== null) textBytes(change.newText);
      return { ...change, path };
    });
    uniquePaths(changes.map(({ path }) => path));
    return this.files(value.workspaceId, async (files) => applyWorkerChangesResultSchema.parse(
      await files.apply(value.agentInstanceId.toLowerCase(), changes, guard),
    ));
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
