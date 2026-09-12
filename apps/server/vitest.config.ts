import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The test database is dropped and rebuilt exactly once per run, here,
     * rather than in each file's beforeAll. Two files doing it concurrently
     * means one drops the database while the other holds connections to it,
     * which surfaces as "Connection terminated unexpectedly" and silently
     * skipped suites.
     */
    globalSetup: ['./test/global-setup.ts'],

    /**
     * Suites share one database, so run files one at a time. Fixtures create
     * their own workspaces and do not collide, but sequential execution keeps
     * connection counts low and failures readable. The whole run is a few
     * seconds.
     */
    fileParallelism: false,

    // Creating and migrating the database on a cold container takes a while.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
