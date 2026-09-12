import { defineConfig } from 'vitest/config';

// D01/D02/D05 Git checks require Git and temporary storage, but no PostgreSQL.
export default defineConfig({
  test: { include: ['test/git.test.ts', 'test/git-files.test.ts', 'test/git-integration.test.ts'], fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 },
});
