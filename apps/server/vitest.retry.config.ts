import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/retry.test.ts'], globalSetup: ['./test/global-setup.ts'],
  fileParallelism: false, testTimeout: 120000, hookTimeout: 120000 } });
