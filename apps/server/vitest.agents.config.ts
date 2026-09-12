import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/agents.test.ts'], globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false, hookTimeout: 120_000, testTimeout: 30_000,
  },
});
