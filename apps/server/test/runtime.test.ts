import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_ID } from '../src/config.js';
import { loadRuntimeConfig, repositoryRoot } from '../src/index.js';
import { buildApp } from '../src/http/app.js';
import { GitWorkspaceLifecycleHook } from '../src/git/lifecycle.js';
import { LocalGitService } from '../src/git/service.js';
import { registerShutdownSignals, startRuntime } from '../src/recovery/runtime.js';
import { connectTestDb, testDatabaseUrl } from './helpers.js';
import { createWorkspaceViaApi, LogCapture, testConfig } from './app-helpers.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'd01-runtime-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('D01 runtime integration', () => {
  it('attaches before listening, creates a repository via HTTP, and retains main on restart', async () => {
    const db = connectTestDb();
    const dbClose = vi.spyOn(db, 'close');
    const liveClose = vi.fn(async () => { await db.pool.query('select 1'); });
    const config = testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl() });
    const attach = vi.fn(async (server) => {
      expect(server.listening).toBe(false);
      return { close: liveClose };
    });
    const runtime = await startRuntime({
      config, createDatabase: () => db, attachLiveDocuments: attach,
      listen: { host: '127.0.0.1', port: 0 },
    });
    let id!: string;
    let mainSha!: string;
    try {
      expect(attach).toHaveBeenCalledWith(runtime.app.server);
      const address = runtime.app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const base = `http://127.0.0.1:${address.port}`;
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok', bootId: config.bootId });
      const response = await fetch(`${base}/api/workspaces`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Persistent' }),
      });
      expect(response.status).toBe(201);
      id = (await response.json() as { workspaceId: string }).workspaceId;
      await runtime.lifecycle.drain();
      mainSha = (await runtime.git.initialize(id)).mainSha;
    } finally {
      await Promise.all([runtime.close(), runtime.close()]);
    }
    expect(liveClose).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(runtime.app.server.listening).toBe(false);

    const restarted = await startRuntime({ config, listen: { host: '127.0.0.1', port: 0 } });
    try {
      expect(await restarted.git.initialize(id)).toEqual({ mainSha });
    } finally { await restarted.close(); }
  });

  it('returns 201 after asynchronous Git failure, then repairs the repository on first access', async () => {
    const db = connectTestDb();
    const logs = new LogCapture();
    const git = new LocalGitService(root);
    let fail = true;
    const hook = new GitWorkspaceLifecycleHook({
      ensureRepository: async (id) => {
        if (fail) throw new Error(`Cannot write ${root}; secret=do-not-log`);
        return git.ensureRepository(id);
      },
    }, (fields) => { app.log.error(fields, 'repository initialization failed'); });
    const app = await buildApp({ db: db.db, config: testConfig({ gitDataRoot: root }), lifecycle: hook, logStream: logs });
    try {
      const { workspaceId } = await createWorkspaceViaApi(app);
      await hook.drain();
      expect(await db.db.selectFrom('workspaces').select('id').where('id', '=', workspaceId).executeTakeFirst()).toBeTruthy();
      expect(logs.text()).toContain('REPOSITORY_UNAVAILABLE');
      expect(logs.text()).not.toContain(root);
      expect(logs.text()).not.toContain('do-not-log');
      fail = false;
      expect((await git.initialize(workspaceId)).mainSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await app.close();
      await hook.drain();
      await db.close();
    }
  });

  it('fails before acquiring DB or HTTP resources when the root cannot be prepared', async () => {
    const path = join(root, 'file');
    await writeFile(path, 'preserve');
    const createDatabase = vi.fn(connectTestDb);
    await expect(startRuntime({ config: testConfig({ gitDataRoot: path }), createDatabase })).rejects.toMatchObject({ code: 'ROOT_UNAVAILABLE' });
    expect(createDatabase).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe('preserve');
  });

  it('closes the acquired database when building the app fails', async () => {
    const db = connectTestDb();
    const close = vi.spyOn(db, 'close');
    await expect(startRuntime({
      config: testConfig({ gitDataRoot: root }), createDatabase: () => db,
      applicationFactory: async () => { throw new Error('failed factory with private information'); },
    })).rejects.toMatchObject({ code: 'STARTUP_FAILED' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes app and DB after an attachment failure', async () => {
    const db = connectTestDb();
    const dbClose = vi.spyOn(db, 'close');
    let appClose = vi.fn();
    await expect(startRuntime({
      config: testConfig({ gitDataRoot: root }), createDatabase: () => db,
      applicationFactory: async (deps) => {
        const app = await buildApp(deps);
        appClose = vi.fn(() => app.server.listening);
        app.addHook('onClose', async () => { appClose(); });
        return app;
      },
      attachLiveDocuments: async () => { throw new Error('attachment failed'); },
    })).rejects.toMatchObject({ code: 'STARTUP_FAILED' });
    expect(appClose).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup even when closing live connections fails', async () => {
    const db = connectTestDb();
    const close = vi.spyOn(db, 'close');
    const runtime = await startRuntime({
      config: testConfig({ gitDataRoot: root }), createDatabase: () => db,
      listen: { host: '127.0.0.1', port: 0 },
      attachLiveDocuments: async () => ({ close: async () => { throw new Error('close failed'); } }),
    });
    await expect(runtime.close()).rejects.toMatchObject({ code: 'SHUTDOWN_FAILED' });
    expect(runtime.app.server.listening).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('process entrypoint configuration and signals', () => {
  it('loads blank optional integrations and a stable data path without changing the source env', () => {
    const env = {
      DATABASE_URL: 'postgresql://unused', PUBLIC_APP_URL: 'http://localhost:5173',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_PUBLISHABLE_KEY: '', GEMINI_API_KEY: '',
    };
    const config = loadRuntimeConfig(env);
    expect(config.gitDataRoot).toBe(resolve(repositoryRoot, 'data'));
    expect(config.SUPABASE_URL).toBeUndefined();
    expect(config.bootId).toBe(BOOT_ID);
    expect(loadRuntimeConfig(env).bootId).toBe(BOOT_ID);
    expect(env.SUPABASE_URL).toBe('');
    expect(loadRuntimeConfig({ ...env, GIT_DATA_ROOT: root }).gitDataRoot).toBe(root);
  });

  it('handles both signals only once and removes its handlers after shutdown', async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => {});
    const dispose = registerShutdownSignals(close, signals, vi.fn());
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await vi.waitFor(() => expect(signals.listenerCount('SIGINT')).toBe(0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    dispose();
  });
});
