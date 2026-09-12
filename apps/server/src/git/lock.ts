import { workspaceIdSchema } from '@app/contracts';

export function canonicalWorkspaceId(value: string): string {
  return workspaceIdSchema.parse(value).toLowerCase();
}

/** Single-runtime lock. Acquire this before a task document gate (section 6.3). */
export class WorkspaceOperationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const key = canonicalWorkspaceId(workspaceId);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
