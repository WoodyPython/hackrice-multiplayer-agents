import type { WorkspaceLifecycleHook } from '@app/contracts';
import type { LocalGitService } from './service.js';
import { GitRuntimeError } from './command.js';

export class GitWorkspaceLifecycleHook implements WorkspaceLifecycleHook {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly git: Pick<LocalGitService, 'ensureRepository'>,
    private readonly reportError: (fields: { workspaceId: string; code: string }) => void,
  ) {}

  onWorkspaceCreated({ workspaceId }: { workspaceId: string }): void {
    const job = Promise.resolve()
      .then(() => this.git.ensureRepository(workspaceId))
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
