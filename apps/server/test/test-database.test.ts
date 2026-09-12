import { afterEach, expect, it, vi } from 'vitest';
import { testDatabaseUrl } from './helpers.js';
afterEach(() => vi.unstubAllEnvs());

it('does not derive a destructive test target from a hosted development database', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://private:secret@example.com/postgres');
  vi.stubEnv('TEST_DATABASE_URL', undefined);
  expect(testDatabaseUrl()).toBe('postgresql://app:app@localhost:54322/app_test');
});
it.each(['app', 'postgres', 'template1', 'app_test%22;drop%20database%20app;--'])('refuses non-test or malformed reset target %s', (name) => {
  vi.stubEnv('TEST_DATABASE_URL', `postgresql://app:app@localhost:54322/${name}`);
  expect(testDatabaseUrl).toThrow('dedicated database');
});
it('allows an explicitly isolated test database', () => {
  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://app:app@localhost:54322/sweep_test');
  expect(testDatabaseUrl()).toContain('/sweep_test');
});
