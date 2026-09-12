import { resetTestDatabase } from './helpers.js';

/**
 * Runs once before any test file. Drops, recreates, and migrates the test
 * database so every run starts from the schema in db/migrations.
 */
export async function setup(): Promise<void> {
  await resetTestDatabase();
}
