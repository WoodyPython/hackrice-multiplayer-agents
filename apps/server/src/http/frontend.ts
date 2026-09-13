import staticFiles from '@fastify/static';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Expose only the SPA entry point and built assets, never neighboring files. */
export async function registerFrontend(app: FastifyInstance, root: string, required = false): Promise<void> {
  try { await access(resolve(root, 'index.html')); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Frontend build unavailable. Run npm run build before npm start.');
  }
  await app.register(staticFiles, {
    root,
    serve: false,
    dotfiles: 'ignore',
    setHeaders(reply, path) {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', path.endsWith('.html')
        ? 'no-cache' : 'public, max-age=31536000, immutable');
    },
  });
  for (const url of ['/', '/signin', '/invite/*', '/w/*', '/demo/*']) {
    app.get(url, async (_request, reply) => reply.sendFile('index.html'));
  }
  // Vite copies public files to the build root. Keep the browser tab icon
  // reachable in production without exposing arbitrary neighboring files.
  app.get('/favicon.svg', async (_request, reply) => reply.sendFile('favicon.svg'));
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const name = request.params['*'];
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.[a-zA-Z0-9]+$/.test(name)) {
      return reply.callNotFound();
    }
    return reply.sendFile(`assets/${name}`);
  });
}
