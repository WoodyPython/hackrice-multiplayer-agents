import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from './config.js';
import { registerShutdownSignals, startRuntime } from './recovery/runtime.js';

// src/index.ts and dist/index.js have the same depth. npm workspace scripts
// change cwd, so both env loading and relative data paths use this stable root.
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadRuntimeConfig(source: NodeJS.ProcessEnv = process.env) {
  const env = { ...source };
  // .env.example intentionally leaves these optional integrations blank.
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'GEMINI_API_KEY']) {
    if (env[key]?.trim() === '') delete env[key];
  }
  env.GIT_DATA_ROOT = resolve(repositoryRoot, env.GIT_DATA_ROOT ?? './data');
  return loadConfig(env);
}

export async function main(): Promise<void> {
  loadDotenv({ path: resolve(repositoryRoot, '.env'), quiet: true });
  const runtime = await startRuntime({ config: loadRuntimeConfig() });
  registerShutdownSignals(runtime.close);
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  void main().catch(() => {
    // Raw configuration, DB and filesystem errors may contain credentials or
    // internal paths. Keep the CLI diagnostic safe for deployment logs.
    console.error('Server startup failed. Check configuration, database connectivity, Git, and writable storage.');
    process.exitCode = 1;
  });
}
