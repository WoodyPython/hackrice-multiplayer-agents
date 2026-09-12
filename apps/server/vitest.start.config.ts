import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/start.test.ts'], globalSetup: ['./test/global-setup.ts'],
  fileParallelism: false, testTimeout: 30000, hookTimeout: 120000,
} });
