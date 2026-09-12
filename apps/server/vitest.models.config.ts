import { defineConfig } from 'vitest/config';

/** C01 can be verified without PostgreSQL or a Gemini key. */
export default defineConfig({
  test: { include: ['test/models.test.ts'], testTimeout: 5000 },
});
