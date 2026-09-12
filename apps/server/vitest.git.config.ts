import { defineConfig } from 'vitest/config';

// D01/D02 Git checks require Git and temporary storage, but no PostgreSQL.
export default defineConfig({
  test: { include: ['test/git.test.ts', 'test/git-files.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
