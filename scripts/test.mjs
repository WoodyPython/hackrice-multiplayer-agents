import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Workspace imports resolve contracts/dist, including after pulling new code.
// Incremental compilation avoids stale contracts in both full and scoped runs.
const root = new URL('../', import.meta.url);
for (const args of [
  [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '--build', fileURLToPath(new URL('packages/contracts', root))],
  [fileURLToPath(new URL('node_modules/vitest/vitest.mjs', root)), ...process.argv.slice(2)],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
