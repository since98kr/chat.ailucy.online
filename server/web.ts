import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

export function registerProductionWeb(app: FastifyInstance) {
  const root = resolve(process.env.CHAT_WEB_ROOT ?? './dist');
  if (!existsSync(root)) return;

  app.register(fastifyStatic, {
    root,
    prefix: '/',
    index: ['index.html'],
    cacheControl: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    immutable: false,
  });

  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.includes('text/html');
    if (request.method === 'GET' && acceptsHtml && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }

    return reply.status(404).send({ error: 'NOT_FOUND' });
  });
}
