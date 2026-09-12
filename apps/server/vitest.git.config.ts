import { defineConfig } from 'vitest/config';

// D01 Git checks require Git and a temporary filesystem, but no PostgreSQL.
export default defineConfig({
  test: { include: ['test/git.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
