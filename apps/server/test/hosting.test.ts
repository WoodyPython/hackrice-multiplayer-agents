import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerFrontend } from '../src/http/frontend.js';
import { registerErrorHandler } from '../src/http/errors.js';
import { loadRuntimeConfig } from '../src/index.js';
import { supabaseServerKey } from '../src/supabase-auth.js';
import { SupabaseBlobStore } from '../src/materials/blob-store.js';
import { SupabaseBroadcaster } from '../src/events/broadcaster.js';
import type { RefreshHint } from '@app/contracts';

describe('production frontend', () => {
  let root: string;
  let app: FastifyInstance;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hosting-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Application</title>');
    await writeFile(join(root, 'assets', 'app.js'), 'window.app = true;');
    app = Fastify();
    registerErrorHandler(app);
    app.get('/health', async () => ({ status: 'ok' }));
    await registerFrontend(app, root);
  });
  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it.each(['/', '/w/123', '/w/123/tasks/456?tab=discussion'])('serves browser navigation to %s', async (url) => {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>Application</title>');
    expect(response.headers['cache-control']).toBe('no-cache');
  });
  it('serves assets and keeps health independent', async () => {
    const asset = await app.inject('/assets/app.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('window.app = true;');
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
  });
  it.each(['/api/missing', '/api', '/assets/missing.js', '/missing.js', '/.env', '/live/missing'])('does not turn %s into HTML', async (url) => {
    const response = await app.inject({ url, headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });
  it('does not rewrite POST requests', async () => {
    expect((await app.inject({ method: 'POST', url: '/w/123', headers: { accept: 'text/html' } })).statusCode).toBe(404);
  });
});

describe('host environment', () => {
  const base = { DATABASE_URL: 'postgresql://unused', RENDER_EXTERNAL_URL: 'https://example.onrender.com' };
  it('uses the Render URL and preserves explicit overrides', () => {
    expect(loadRuntimeConfig(base).PUBLIC_APP_URL).toBe(base.RENDER_EXTERNAL_URL);
    expect(loadRuntimeConfig({ ...base, PUBLIC_APP_URL: 'https://custom.example' }).PUBLIC_APP_URL).toBe('https://custom.example');
    expect(loadRuntimeConfig({ ...base, PUBLIC_APP_URL: '' }).PUBLIC_APP_URL).toBe(base.RENDER_EXTERNAL_URL);
  });
  it('normalizes blank secret keys and prefers the modern server key', () => {
    const config = loadRuntimeConfig({ ...base, SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: 'legacy' });
    expect(config.SUPABASE_SECRET_KEY).toBeUndefined();
    expect(supabaseServerKey(config)).toBe('legacy');
    expect(supabaseServerKey({ ...config, SUPABASE_SECRET_KEY: 'sb_secret_test' })).toBe('sb_secret_test');
  });
});

describe('Supabase request credentials', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['sb_secret_test', 'legacy.jwt.key'])('authenticates Storage and Broadcast with %s', async (key) => {
    const fetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const store = new SupabaseBlobStore({ url: 'https://example.supabase.co', serviceRoleKey: key, bucket: 'materials' });
    await store.get('00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002');
    await new SupabaseBroadcaster({ url: 'https://example.supabase.co', serviceRoleKey: key }).hint({} as RefreshHint);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      const headers = new Headers((call as unknown as [string, RequestInit])[1].headers);
      expect(headers.get('apikey')).toBe(key);
      expect(headers.get('authorization')).toBe(key.startsWith('sb_secret_') ? null : `Bearer ${key}`);
    }
  });
});
