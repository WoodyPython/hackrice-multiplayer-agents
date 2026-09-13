import type { WorkspaceLifecycleHook } from '@app/contracts';
import type { LocalGitService } from './service.js';
import { GitRuntimeError } from './command.js';

export class GitWorkspaceLifecycleHook implements WorkspaceLifecycleHook {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly git: Pick<LocalGitService, 'ensureRepository' | 'removeRepository'>,
    private readonly reportError: (fields: { workspaceId: string; code: string }) => void,
  ) {}

  onWorkspaceCreated({ workspaceId }: { workspaceId: string }): void {
    this.run(workspaceId, () => this.git.ensureRepository(workspaceId));
  }

  /**
   * The workspace row is already gone, so its repository and worktrees are
   * unreachable data on a fixed-size disk.
   *
   * Fire-and-forget in exactly the way creation is, and for the mirror reason:
   * creation must not be able to fail a request the database already accepted,
   * and neither must deletion. A repository that outlives its rows is space to
   * reclaim, which the workspace garbage collector does; a delete that failed
   * because the disk hiccuped would instead be a workspace the person was told
   * they removed and can still see.
   */
  onWorkspaceDeleted({ workspaceId }: { workspaceId: string }): void {
    this.run(workspaceId, () => this.git.removeRepository(workspaceId));
  }

  private run(workspaceId: string, operation: () => Promise<unknown>): void {
    const job = Promise.resolve()
      .then(operation)
      .then(() => undefined)
      .catch((error: unknown) => {
        try {
          this.reportError({
            workspaceId,
            code: error instanceof GitRuntimeError ? error.code : 'REPOSITORY_UNAVAILABLE',
          });
        } catch { /* A failing logger cannot reject this fire-and-forget hook. */ }
      });
    this.pending.add(job);
    void job.then(() => this.pending.delete(job));
  }

  /** Called after HTTP requests have drained, before closing persistence. */
  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}
