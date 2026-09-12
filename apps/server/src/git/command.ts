import { execFile } from 'node:child_process';

export class GitRuntimeError extends Error {
  constructor(public readonly code: string) {
    super(`Git runtime operation failed (${code}).`);
    this.name = 'GitRuntimeError';
  }
}

export interface GitResult {
  stdout: string;
  exitCode: number;
}

export type GitRunner = (
  args: readonly string[],
  options?: { input?: string; allowedExitCodes?: readonly number[] },
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
  });

  return new Promise((resolve, reject) => {
    const child = execFile('git', [...args], {
      env,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (!error) return resolve({ stdout, exitCode: 0 });
      if (typeof error.code === 'number' && options.allowedExitCodes?.includes(error.code)) {
        return resolve({ stdout, exitCode: error.code });
      }
      // child_process errors include command arguments and paths. Do not retain
      // the original error/cause or stderr in anything a logger can serialize.
      reject(new GitRuntimeError(error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'COMMAND_FAILED'));
    });
    child.stdin?.on('error', () => { /* The process callback reports failure. */ });
    child.stdin?.end(options.input ?? '');
  });
};
