import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const contentTypes: Record<string, string> = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', ico: 'image/x-icon',
};

/** Serve only the compiled application, never workspace or uploaded files. */
export async function registerFrontend(app: FastifyInstance, root: string, required = false): Promise<void> {
  let index: Buffer;
  try { index = await readFile(join(root, 'index.html')); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Frontend build unavailable. Run npm run build before npm start.');
  }
  for (const url of ['/', '/w/*', '/demo/*']) {
    app.get(url, async (_request, reply) => reply
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .type('text/html; charset=utf-8').send(index));
  }
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const name = request.params['*'];
    // Vite emits flat, hashed asset names. No arbitrary filesystem selector.
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.[a-zA-Z0-9]+$/.test(name)) return reply.code(404).send();
    const type = contentTypes[name.split('.').at(-1)!];
    if (!type) return reply.code(404).send();
    try {
      const bytes = await readFile(join(root, 'assets', name));
      return reply.header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff').type(type).send(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send();
      throw error;
    }
  });
}
