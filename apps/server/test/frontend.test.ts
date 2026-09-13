import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { registerFrontend } from '../src/http/frontend.js';

it('serves SPA deep links and Monaco assets without exposing neighboring files or swallowing API errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frontend-'));
  const app = Fastify();
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<main>App</main>');
    await writeFile(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(root, 'assets', 'editor.worker-Ab12.js'), '/* worker */');
    await writeFile(join(root, 'secret.txt'), 'not public');
    await registerFrontend(app, root, true);
    for (const path of ['/', '/signin', '/signin?next=%2Finvite%2Fabc', '/invite/abc', '/w/abc/files', '/demo/w/abc']) {
      const res = await app.inject(path);
      expect(res.statusCode).toBe(200); expect(res.body).toBe('<main>App</main>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
    const worker = await app.inject('/assets/editor.worker-Ab12.js');
    expect(worker.statusCode).toBe(200);
    expect(worker.headers['content-type']).toContain('javascript');
    expect(worker.headers['x-content-type-options']).toBe('nosniff');
    const favicon = await app.inject('/favicon.svg?v=2');
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['content-type']).toContain('image/svg+xml');
    for (const path of ['/assets/%2e%2e%2fsecret.txt', '/assets/%2e%2e%5csecret.txt', '/assets/missing.js', '/api/missing', '/secret.txt']) {
      const res = await app.inject(path); expect(res.statusCode).toBe(404); expect(res.body).not.toContain('not public');
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

it('fails clearly on a missing production build while permitting a Vite-only development app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'missing-frontend-'));
  const app = Fastify();
  try {
    await expect(registerFrontend(app, root, true)).rejects.toThrow('Frontend build unavailable');
    await registerFrontend(app, root);
    expect((await app.inject('/')).statusCode).toBe(404);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
