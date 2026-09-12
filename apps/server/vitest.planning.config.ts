import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['test/plan-validation.test.ts', 'test/planner.test.ts'],
  globalSetup: ['./test/global-setup.ts'], fileParallelism: false,
  testTimeout: 30000, hookTimeout: 120000,
} });
