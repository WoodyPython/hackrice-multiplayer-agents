import { defineConfig } from 'vitest/config';

/** These suites need neither PostgreSQL nor Git. */
export default defineConfig({
  test: { include: ['test/models.test.ts', 'test/plan-validation.test.ts', 'test/hosting.test.ts', 'test/refresh-stream.test.ts', 'test/presence.test.ts', 'test/briefing-compose.test.ts', 'test/editor-text.test.ts'], testTimeout: 5000 },
});
