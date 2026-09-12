/** FIFO task barrier. Git callers acquire the workspace lock before this gate. */
export class TaskDocumentGate {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(taskId: string, operation: () => T | Promise<T>): Promise<T> {
    const key = taskId.toLowerCase();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}
