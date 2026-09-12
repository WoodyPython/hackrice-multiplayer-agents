import staticFiles from '@fastify/static';
import { access } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { sendNotFound } from './errors.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

/** Only the built public directory is exposed; missing assets remain 404s. */
export async function registerFrontend(app: FastifyInstance, root = webRoot): Promise<void> {
  await access(resolve(root, 'index.html'));
  await app.register(staticFiles, {
    root,
    index: ['index.html'],
    dotfiles: 'ignore',
    setHeaders(response, path) {
      response.header('Cache-Control', path.endsWith('.html')
        ? 'no-cache' : 'public, max-age=0, must-revalidate');
    },
  });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    const reserved = /^\/(api|health|live|assets)(\/|$)/.test(path);
    if ((request.method === 'GET' || request.method === 'HEAD') &&
        request.headers.accept?.includes('text/html') &&
        !reserved && !extname(path) && !path.includes('/.') && !path.includes('%')) {
      return reply.sendFile('index.html');
    }
    return sendNotFound(request, reply);
  });
}
