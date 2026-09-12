import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ApiError, MAX_TEXT_FILE_BYTES, shaSchema, type GitReadTarget, type TextChange, type WorkerCommitGuard } from '@app/contracts';
import { GitRuntimeError, type GitRunner } from './command.js';
import { blobHash, decodeText, directories, diskBytes, filePath, inspectFile, invalidPath, portablePaths, stat, textBytes } from './files.js';

type Kind = 'human' | 'agents' | 'results';
interface Entry { mode: string; hash: string }
interface Managed { branch: string; worktreePath: string; admin: string; head: string }
type Tree = Map<string, Entry>;

/** Only constructed inside LocalGitService.withRepository: this class never locks. */
export class ManagedWorktrees {
  constructor(
    private readonly root: string,
    private readonly workspaceId: string,
    private readonly repository: string,
    private readonly git: GitRunner,
  ) {}

  private command(args: string[], options?: Parameters<GitRunner>[1]) {
    return this.git(['--git-dir', this.repository, ...args], options);
  }

  private async ref(ref: string): Promise<string | undefined> {
    const result = await this.command(['show-ref', '--verify', '--hash', ref], { allowedExitCodes: [1, 128] });
    if (result.exitCode !== 0) {
      // show-ref uses 128 for absent refs, too. Do not mistake malformed loose
      // refs for absence and overwrite them.
      if (await stat(join(this.repository, ref))) throw new GitRuntimeError('INVALID_REF');
      return undefined;
    }
    return shaSchema.parse(result.stdout.trim());
  }

  private async commit(sha: string): Promise<string> {
    // A full object ID, never a revision expression supplied by a caller.
    const type = (await this.command(['cat-file', '-t', sha], { allowedExitCodes: [128] }));
    if (type.exitCode !== 0 || type.stdout.trim() !== 'commit') {
      throw new ApiError('VALIDATION_FAILED', 'Base must be a commit in this workspace repository.');
    }
    return sha;
  }

  private async tree(sha: string): Promise<Tree> {
    const result = await this.command(['ls-tree', '-r', '-z', '--full-tree', sha], { binary: true });
    let listing: string;
    try { listing = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdoutBytes!); }
    catch { return invalidPath(); }
    const entries: Tree = new Map();
    for (const line of listing.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
      if (!match) throw new GitRuntimeError('INVALID_TREE');
      const [, mode, type, hash, raw] = match;
      const path = filePath(raw!);
      if (path !== raw || type !== 'blob' || !['100644', '100755'].includes(mode!)) invalidPath();
      entries.set(path, { mode: mode!, hash: hash! });
    }
    portablePaths(entries.keys());
    return entries;
  }

  private async blob(hash: string): Promise<Buffer> {
    const size = Number((await this.command(['cat-file', '-s', hash])).stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new GitRuntimeError('INVALID_BLOB');
    if (size > MAX_TEXT_FILE_BYTES) throw new ApiError('VALIDATION_FAILED', 'File exceeds the 1 MiB limit.');
    const { stdoutBytes } = await this.command(['cat-file', 'blob', hash], { binary: true });
    if (!stdoutBytes || stdoutBytes.length !== size) throw new GitRuntimeError('INVALID_BLOB');
    decodeText(stdoutBytes);
    return stdoutBytes;
  }

  private location(kind: Kind, id: string) {
    return {
      branch: `${kind}/${id}`,
      worktreePath: join(this.root, 'worktrees', this.workspaceId, kind, id),
      baseRef: `refs/app/bases/${kind}/${id}`,
    };
  }

  private async parent(kind: Kind, create: boolean) {
    return directories(this.root, ['worktrees', this.workspaceId, kind], create);
  }

  private async metadataFile(path: string): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) {
      throw new GitRuntimeError('INVALID_WORKTREE');
    }
    return (await readFile(path, 'utf8')).trim();
  }

  /** Validate reciprocal registration before letting Git access a worktree index. */
  private async registration(worktreePath: string, branch: string): Promise<string> {
    const dotgit = await this.metadataFile(join(worktreePath, '.git'));
    if (!dotgit.startsWith('gitdir: ')) throw new GitRuntimeError('INVALID_WORKTREE');
    const admin = resolve(worktreePath, dotgit.slice(8));
    const adminRoot = join(this.repository, 'worktrees');
    const child = relative(adminRoot, admin);
    if (!child || isAbsolute(child) || child === '..' || /[\\/]/.test(child)) {
      throw new GitRuntimeError('INVALID_WORKTREE');
    }
    await directories(this.repository, ['worktrees', child]);
    if (await realpath(admin) !== join(await realpath(adminRoot), child)) throw new GitRuntimeError('INVALID_WORKTREE');
    const gitdir = await this.metadataFile(join(admin, 'gitdir'));
    const common = await this.metadataFile(join(admin, 'commondir'));
    const head = await this.metadataFile(join(admin, 'HEAD'));
    if (resolve(admin, gitdir) !== join(worktreePath, '.git') ||
        resolve(admin, common) !== this.repository || head !== `ref: refs/heads/${branch}`) {
      throw new GitRuntimeError('INVALID_WORKTREE');
    }
    const index = await stat(join(admin, 'index'));
    if (index && (!index.isFile() || index.isSymbolicLink() || index.nlink !== 1)) throw new GitRuntimeError('INVALID_WORKTREE');
    return admin;
  }

  async ensure(kind: Kind, id: string, base: string | undefined, create: boolean, synchronize = true): Promise<Managed> {
    const { branch, worktreePath, baseRef } = this.location(kind, id);
    const headRef = `refs/heads/${branch}`;
    let head = await this.ref(headRef);
    const recordedBase = await this.ref(baseRef);
    if (!!head !== !!recordedBase) throw new GitRuntimeError('INVALID_WORKTREE_REFS');
    if (base) await this.commit(base);
    if (head && base && kind !== 'human' && recordedBase !== base) {
      throw new ApiError('INPUT_CONFLICT', 'This workspace was initialized from a different base commit.');
    }
    if (!head && !create) throw new ApiError('INVALID_STATE', 'Create this Git workspace before accessing it.');
    const start = head ?? base!;
    await this.commit(start);
    if (head && recordedBase) {
      await this.commit(recordedBase);
      const ancestry = await this.command(['merge-base', '--is-ancestor', recordedBase, head], { allowedExitCodes: [1] });
      if (ancestry.exitCode !== 0) throw new GitRuntimeError('INVALID_WORKTREE_REFS');
    }
    const tree = await this.tree(start);
    // Validate the full checkout before creating refs or writing any content.
    if (synchronize) for (const entry of tree.values()) await this.blob(entry.hash);
    const parentExists = await this.parent(kind, false);
    const existing = parentExists ? await stat(worktreePath) : undefined;
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) invalidPath();
    if (existing) {
      if (!head) throw new GitRuntimeError('OCCUPIED_WORKTREE');
      const admin = await this.registration(worktreePath, branch);
      const managed = { branch, worktreePath, admin, head };
      if (synchronize) await this.synchronize(managed, tree);
      return managed;
    }
    await this.parent(kind, true);
    if (!head) {
      await this.command(['update-ref', '--stdin'], {
        input: `start\ncreate ${baseRef} ${start}\ncreate ${headRef} ${start}\nprepare\ncommit\n`,
      });
      head = start;
    }
    // Prune stale registrations only (no refs/content). Git refuses to reuse
    // an occupied or locked registration; it must never be force-overridden.
    await this.command(['worktree', 'prune', '--expire', 'now']);
    await this.command(['worktree', 'add', '--no-checkout', worktreePath, branch]);
    const admin = await this.registration(worktreePath, branch);
    const managed = { branch, worktreePath, admin, head };
    await this.synchronize(managed, tree);
    return managed;
  }

  async read(target: GitReadTarget, path: string) {
    let head: string;
    if (target.kind === 'commit') head = await this.commit(target.commitSha);
    else {
      const kind = target.kind === 'draft' ? 'human' : target.kind === 'worker' ? 'agents' : 'results';
      const id = target.kind === 'draft' ? target.taskId : target.kind === 'worker' ? target.agentInstanceId : target.runId;
      const managed = await this.ensure(kind, id.toLowerCase(), undefined, false, false);
      await inspectFile(managed.worktreePath, path);
      head = managed.head;
    }
    const tree = await this.tree(head);
    portablePaths(new Set([...tree.keys(), path]));
    const entry = tree.get(path);
    return { path, text: entry ? decodeText(await this.blob(entry.hash)) : null, hash: entry?.hash ?? null };
  }

  async checkpoint(taskId: string, base: string, files: Array<{ path: string; text: string }>) {
    const managed = await this.ensure('human', taskId, base, true);
    const current = await this.tree(managed.head);
    const changes = files.map(({ path, text }) => ({ path, newText: text, expectedHash: current.get(path)?.hash ?? null }));
    return this.mutate(managed, changes, `Checkpoint human draft ${taskId}`);
  }

  async apply(agentInstanceId: string, changes: TextChange[], guard?: WorkerCommitGuard) {
    const managed = await this.ensure('agents', agentInstanceId, undefined, false);
    return this.mutate(managed, changes, `Checkpoint worker ${agentInstanceId}`, guard);
  }

  private async mutate(managed: Managed, changes: TextChange[], message: string, guard?: WorkerCommitGuard) {
    const current = await this.tree(managed.head);
    const proposed = new Map(current);
    const replacements = new Map<string, Buffer>();
    for (const change of changes) {
      await inspectFile(managed.worktreePath, change.path);
      const currentHash = current.get(change.path)?.hash ?? null;
      if (change.expectedHash !== currentHash) {
        throw new ApiError('FILE_VERSION_CHANGED', 'File changed since it was read.', { path: change.path, currentHash });
      }
      if (change.newText === null) proposed.delete(change.path);
      else {
        const bytes = textBytes(change.newText);
        replacements.set(change.path, bytes);
        proposed.set(change.path, { mode: '100644', hash: blobHash(bytes) });
      }
    }
    // Also reject file/directory transitions within one batch: no implicit
    // recursive deletion or replacement of a directory is a text operation.
    portablePaths(new Set([...current.keys(), ...proposed.keys()]));
    const changedPaths = changes.filter(({ path }) => {
      const old = current.get(path), next = proposed.get(path);
      return old?.hash !== next?.hash || old?.mode !== next?.mode;
    }).map(({ path }) => path).sort();
    if (!changedPaths.length) {
      const checkpoint = { commitSha: managed.head, changedPaths };
      if (guard) await guard(checkpoint, async () => {});
      return checkpoint;
    }

    const temporary = await mkdtemp(join(managed.admin, 'batch-'));
    const indexFile = join(temporary, 'index');
    let commitSha: string;
    try {
      await this.command(['read-tree', managed.head], { indexFile });
      let records = '';
      for (const path of changedPaths) {
        const next = proposed.get(path);
        if (!next) records += `0 ${'0'.repeat(40)}\t${path}\0`;
        else {
          const bytes = replacements.get(path)!;
          const hash = (await this.command(['hash-object', '-w', '--stdin', '--no-filters'], { input: bytes })).stdout.trim();
          if (hash !== next.hash) throw new GitRuntimeError('INVALID_BLOB');
          records += `100644 ${hash}\t${path}\0`;
        }
      }
      await this.command(['update-index', '-z', '--index-info'], { indexFile, input: records });
      const tree = (await this.command(['write-tree'], { indexFile })).stdout.trim();
      commitSha = shaSchema.parse((await this.command(['commit-tree', tree, '-p', managed.head, '-m', message])).stdout.trim());
    } finally {
      // Exact server-allocated metadata directory only; never a workspace root.
      await rm(temporary, { recursive: true, force: true });
    }
    // Finish candidate cleanup before publishing: all failures from here on
    // either reject the CAS or explicitly report a committed projection failure.
    const publish = async () => { await this.command(['update-ref', `refs/heads/${managed.branch}`, commitSha, managed.head]); };
    if (guard) await guard({ commitSha, changedPaths }, publish);
    else await publish();
    try { await this.synchronize({ ...managed, head: commitSha }, proposed); }
    catch { throw new GitRuntimeError('WORKTREE_SYNC_FAILED'); }
    return { commitSha, changedPaths };
  }

  private async projection(managed: Managed): Promise<Tree> {
    const marker = join(managed.admin, 'app-projection-sha');
    if (!await stat(marker)) return new Map(); // newly added, not yet materialized
    const result = shaSchema.safeParse(await this.metadataFile(marker));
    if (!result.success) throw new GitRuntimeError('INVALID_PROJECTION');
    await this.commit(result.data);
    const ancestor = await this.command(['merge-base', '--is-ancestor', result.data, managed.head], { allowedExitCodes: [1] });
    if (ancestor.exitCode !== 0) throw new GitRuntimeError('INVALID_PROJECTION');
    return this.tree(result.data);
  }

  /** Inspect every existing entry without following links or special files. */
  private async diskFiles(root: string, prefix = ''): Promise<string[]> {
    const files: string[] = [];
    for (const name of await readdir(join(root, prefix))) {
      if (!prefix && name === '.git') continue; // reciprocal registration checked above
      const path = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) invalidPath();
      if (info.isDirectory()) files.push(...await this.diskFiles(root, path));
      else { if (filePath(path) !== path) invalidPath(); files.push(path); }
    }
    portablePaths(files);
    return files;
  }

  private async synchronize(managed: Managed, desired: Tree): Promise<void> {
    // The Git index is not a checkpoint: an operator could have staged an
    // uncommitted edit there. Compare against our last materialized commit.
    const previous = await this.projection(managed);
    portablePaths(new Set([...previous.keys(), ...desired.keys()]));
    // An index is not authority, but it may hold valuable staged-only edits.
    // A normal or interrupted projection has exactly the old or new index.
    const listing = await this.git(['--git-dir', managed.admin, '--work-tree', managed.worktreePath,
      'ls-files', '--stage', '-z']);
    const indexed: Tree = new Map();
    for (const line of listing.stdout.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(line);
      if (!match) throw new GitRuntimeError('DIRTY_WORKTREE');
      indexed.set(match[3]!, { mode: match[1]!, hash: match[2]! });
    }
    const matches = (tree: Tree) => indexed.size === tree.size && [...indexed].every(([path, entry]) =>
      tree.get(path)?.hash === entry.hash && tree.get(path)?.mode === entry.mode);
    if (!matches(previous) && !matches(desired)) throw new GitRuntimeError('DIRTY_WORKTREE');
    const bytes = new Map<string, Buffer>();
    for (const [path, entry] of desired) {
      const exists = await inspectFile(managed.worktreePath, path);
      // Replacements use atomic rename, so a previously materialized file that
      // remains in the new tree cannot vanish during a legitimate refresh.
      if (!exists && previous.has(path)) throw new GitRuntimeError('DIRTY_WORKTREE');
      bytes.set(path, await this.blob(entry.hash));
    }
    // Accept old OR new bytes after a partial refresh. Never overwrite unknown
    // local modifications or remove an unrelated untracked file.
    const existing = await this.diskFiles(managed.worktreePath);
    for (const path of existing) {
      const actual = await diskBytes(managed.worktreePath, path);
      const hash = actual && blobHash(actual);
      if (!hash || (hash !== previous.get(path)?.hash && hash !== desired.get(path)?.hash)) {
        throw new GitRuntimeError('DIRTY_WORKTREE');
      }
    }
    const staging = await mkdtemp(join(managed.admin, 'projection-'));
    try {
      let sequence = 0;
      for (const path of existing) {
        if (!desired.has(path)) await unlink(join(managed.worktreePath, path));
      }
      for (const [path, content] of bytes) {
        const current = await diskBytes(managed.worktreePath, path);
        const destination = join(managed.worktreePath, path);
        if (!current?.equals(content)) {
          await directories(managed.worktreePath, path.split('/').slice(0, -1), true);
          const temporary = join(staging, String(sequence++));
          await writeFile(temporary, content, { flag: 'wx' });
          await rename(temporary, destination);
        }
        if (process.platform !== 'win32') await chmod(destination, desired.get(path)!.mode === '100755' ? 0o755 : 0o644);
      }
      // Refresh metadata only. File materialization above bypasses Git filters,
      // attributes, hooks, CRLF conversion, and generated-code execution.
      await this.git(['--git-dir', managed.admin, '--work-tree', managed.worktreePath, 'read-tree', managed.head]);
      const marker = join(staging, 'projection-sha');
      await writeFile(marker, `${managed.head}\n`, { flag: 'wx' });
      await rename(marker, join(managed.admin, 'app-projection-sha'));
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
