import { execFile } from 'node:child_process';

export class GitRuntimeError extends Error {
  constructor(public readonly code: string) {
    super(`Git runtime operation failed (${code}).`);
    this.name = 'GitRuntimeError';
  }
}

export interface GitResult {
  stdout: string;
  /** Populated only for binary reads; stdout is empty in that mode. */
  stdoutBytes?: Buffer;
  exitCode: number;
}

export type GitRunner = (
  args: readonly string[],
  options?: {
    input?: string | Uint8Array;
    allowedExitCodes?: readonly number[];
    binary?: boolean;
    /** Trusted, absolute, server-allocated index path; not an arbitrary env map. */
    indexFile?: string;
  },
) => Promise<GitResult>;

/** Backend-only arguments. Never expose this runner as a model or HTTP tool. */
export const runGit: GitRunner = (args, options = {}) => {
  // A developer's Git environment must not redirect writes to their checkout.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Workspace Server',
    GIT_AUTHOR_EMAIL: 'workspace@localhost',
    GIT_COMMITTER_NAME: 'Workspace Server',
    GIT_COMMITTER_EMAIL: 'workspace@localhost',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1',
  });
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;

  return new Promise((resolve, reject) => {
    const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const child = execFile('git', [
      '-c', `core.hooksPath=${nullPath}`, '-c', `core.attributesFile=${nullPath}`,
      '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false', '-c', 'commit.gpgSign=false',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args,
    ], {
      env,
      shell: false,
      windowsHide: true,
      encoding: 'buffer',
      timeout: 30_000,
      // Blob size is checked before reading. Tree/index listings need more room
      // than a single file; this is a command transport bound, not a file quota.
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      const output = options.binary ? { stdout: '', stdoutBytes: stdout } : { stdout: stdout.toString('utf8') };
      if (!error) return resolve({ ...output, exitCode: 0 });
      if (typeof error.code === 'number' && options.allowedExitCodes?.includes(error.code)) {
        return resolve({ ...output, exitCode: error.code });
      }
      // child_process errors include command arguments and paths. Do not retain
      // the original error/cause or stderr in anything a logger can serialize.
      reject(new GitRuntimeError(error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'COMMAND_FAILED'));
    });
    child.stdin?.on('error', () => { /* The process callback reports failure. */ });
    child.stdin?.end(options.input ?? '');
  });
};
