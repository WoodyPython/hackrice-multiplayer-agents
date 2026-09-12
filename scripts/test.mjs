import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Workspace imports resolve contracts/dist, including after pulling new code.
// Incremental compilation avoids stale contracts in both full and scoped runs.
const root = new URL('../', import.meta.url);
// Deep Windows checkouts can push Git worktree paths beyond its path limit.
const temporaryRoot = process.platform === 'win32'
  ? join(tmpdir(), 'hackrice-tests')
  : fileURLToPath(new URL('local-tasks/test-tmp/', root));
mkdirSync(temporaryRoot, { recursive: true });
for (const args of [
  [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '--build', fileURLToPath(new URL('packages/contracts', root))],
  [fileURLToPath(new URL('node_modules/vitest/vitest.mjs', root)), ...process.argv.slice(2)],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, TMP: temporaryRoot, TEMP: temporaryRoot, TMPDIR: temporaryRoot } });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
