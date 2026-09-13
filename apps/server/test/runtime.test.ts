import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PgRunStore } from '../src/runs/run-store.js';
import { LocalReviewService } from '../src/reviews/service.js';
import { insertWorkspace, insertTask, insertRun, insertBudget, insertAgentInstance, insertDiscussionEntry, sessionCookie } from './helpers.js';
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
import { createWorkspaceViaApi, LogCapture, testConfig, authenticateRuntime } from './app-helpers.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'd01-runtime-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('D01 runtime integration', () => {
  it.each(['planning', 'working', 'needs_input'] as const)('D08 interrupts %s before transport and permits explicit retry', async (status) => {
    const db = connectTestDb();
    const workspaceId = await insertWorkspace(db.db);
    const taskId = await insertTask(db.db, workspaceId, { status });
    const runId = await insertRun(db.db, workspaceId, taskId, { status });
    await db.db.updateTable('tasks').set({ active_run_id: runId }).where('id', '=', taskId).execute();
    await insertBudget(db.db, workspaceId, taskId, 'orchestrator');
    const agentId = await insertAgentInstance(db.db, workspaceId, taskId, runId);
    const entryId = await insertDiscussionEntry(db.db, workspaceId, taskId);
    const question = await db.db.insertInto('agent_questions').values({ workspace_id: workspaceId, task_id: taskId,
      run_id: runId, agent_instance_id: agentId, question_entry_id: entryId, expires_at: new Date(Date.now() + 60_000) }).returning('id').executeTakeFirstOrThrow();
    const config = testConfig({ gitDataRoot: root, DATABASE_URL: testDatabaseUrl(), bootId: randomUUID() });
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    try {
      runtime = await startRuntime({ config, listen: { host: '127.0.0.1', port: 0 }, attachLiveDocuments: async (server) => {
        expect(server.listening).toBe(false);
        expect(await db.db.selectFrom('tasks').select(['status', 'active_run_id']).where('id', '=', taskId).executeTakeFirst())
          .toEqual({ status: 'interrupted', active_run_id: null });
        expect((await db.db.selectFrom('agent_instances').select('status').where('id', '=', agentId).executeTakeFirst())!.status).toBe('interrupted');
        expect((await db.db.selectFrom('agent_questions').select('status').where('id', '=', question.id).executeTakeFirst())!.status).toBe('canceled');
        return { close: async () => {} };
      } });
      await authenticateRuntime(runtime.app, db.db);
      const old = new PgRunStore({ db: db.db, bootId: BOOT_ID });
      await expect(old.recordResultHead(runId, 'a'.repeat(40))).rejects.toMatchObject({ code: 'RUN_INTERRUPTED' });
      const response = await runtime.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/tasks/${taskId}/retry`, payload: { clientRequestId: randomUUID() } });
      expect(response.statusCode).toBe(202);
      expect(response.json().attempt).toBe(2);
      await old.settle(runId, 'completed');
      expect((await old.read(runId))!.status).toBe('interrupted');
    } finally { await runtime?.close(); await db.close(); }
  });

  it('D08 closes resources without attaching transport when reconciliation fails', async () => {
    const db = connectTestDb();
    const closed = vi.spyOn(db, 'close');
    const attach = vi.fn();
    const recover = vi.spyOn(LocalReviewService.prototype, 'reconcilePreviousApplies').mockRejectedValue(new Error('injected'));
    try {
      await expect(startRuntime({ config: testConfig({ gitDataRoot: root }), createDatabase: () => db,
        attachLiveDocuments: attach })).rejects.toMatchObject({ code: 'STARTUP_FAILED' });
      expect(attach).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledTimes(1);
    } finally { recover.mockRestore(); }
  });

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
      await authenticateRuntime(runtime.app, db.db);
      const response = await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sessionCookie() },
        body: JSON.stringify({ name: 'Persistent' }),
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
    await authenticateRuntime(app, db.db);
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
