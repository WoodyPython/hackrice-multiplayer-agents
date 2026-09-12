import { defineConfig } from 'vitest/config';

/** Pure model adapters and graph validation need neither PostgreSQL nor Git. */
export default defineConfig({
  test: { include: ['test/models.test.ts', 'test/plan-validation.test.ts'], testTimeout: 5000 },
});
