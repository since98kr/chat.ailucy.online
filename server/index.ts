import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChatDatabase } from './database.js';
import { adapterHealth, getAdapter } from './adapters/index.js';
import { storeArtifact } from './artifacts.js';
import { getArtifact } from './artifact-repository.js';
import type { StreamEvent, SystemId } from '../shared/contracts.js';

const conversationStatusSchema = z.enum(['active', 'archived', 'trashed']);
const systemIdSchema = z.enum(['letta', 'hermes']);

const createConversationSchema = z.object({
  systemId: systemIdSchema,
  agentId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(160).optional(),
});

const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    pinned: z.boolean().optional(),
    status: conversationStatusSchema.optional(),
    draft: z.string().max(100_000).optional(),
    lastReadMessageId: z.string().uuid().nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'At least one field is required');

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(200_000),
  clientMessageId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().nullable().optional(),
});

function eventLine(event: StreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

export function buildApp(options?: { databasePath?: string; artifactRoot?: string }) {
  if (options?.artifactRoot) process.env.CHAT_ARTIFACT_ROOT = options.artifactRoot;
  const db = new ChatDatabase(options?.databasePath);
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.register(cors, {
    origin: process.env.CHAT_ALLOWED_ORIGIN?.split(',').map((value) => value.trim()) ?? true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.register(multipart, {
    limits: {
      files: 1,
      fileSize: Number(process.env.CHAT_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        details: error.flatten(),
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    });
  });

  app.addHook('onClose', async () => {
    db.close();
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'chat-ailucy-v2',
    adapters: await adapterHealth(),
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/conversations', async (request) => {
    const query = z
      .object({
        systemId: systemIdSchema.optional(),
        status: conversationStatusSchema.default('active'),
      })
      .parse(request.query);

    return { conversations: db.listConversations(query.systemId, query.status) };
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const conversation = db.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { conversation };
  });

  app.post('/api/conversations', async (request, reply) => {
    const input = createConversationSchema.parse(request.body);
    const conversation = db.createConversation(input.systemId, input.agentId, input.title);
    return reply.status(201).send({ conversation });
  });

  app.patch('/api/conversations/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateConversationSchema.parse(request.body);
    const conversation = db.updateConversation(id, input);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    return { conversation };
  });

  app.delete('/api/conversations/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const conversation = db.getConversation(id);
    if (!conversation) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    if (conversation.status !== 'trashed') {
      return reply.status(409).send({ error: 'CONVERSATION_MUST_BE_TRASHED_FIRST' });
    }
    db.deleteConversation(id);
    return reply.status(204).send();
  });

  app.post('/api/conversations/:id/messages/stream', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = sendMessageSchema.parse(request.body);
    const existing = db.getConversation(id);
    if (!existing) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });

    const userMessage = db.addMessage({
      id: input.clientMessageId,
      conversationId: id,
      role: 'user',
      authorId: 'tei',
      content: input.content,
      parentMessageId: input.parentMessageId,
    });
    const runId = randomUUID();
    const assistantMessage = db.addMessage({
      conversationId: id,
      role: 'assistant',
      authorId: existing.agentId,
      content: '',
      state: 'streaming',
      parentMessageId: userMessage.id,
    });
    const adapter = getAdapter(existing.systemId as SystemId);
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());

    async function* generate() {
      yield eventLine({ type: 'message.accepted', message: userMessage });
      yield eventLine({ type: 'run.started', runId });

      let content = '';
      try {
        const latest = db.getConversation(id)!;
        for await (const item of adapter.streamReply({
          conversation: latest,
          userMessage,
          history: latest.messages,
          signal: controller.signal,
        })) {
          if (item.type === 'status') {
            yield eventLine({ type: 'run.status', runId, status: item.status });
          } else {
            content += item.delta;
            db.updateMessage(assistantMessage.id, { content, state: 'streaming' });
            yield eventLine({
              type: 'content.delta',
              runId,
              messageId: assistantMessage.id,
              delta: item.delta,
            });
          }
        }

        const finalMessage = db.updateMessage(assistantMessage.id, {
          content,
          state: controller.signal.aborted ? 'cancelled' : 'complete',
        })!;
        yield eventLine({ type: 'run.completed', runId, message: finalMessage });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown adapter error';
        db.updateMessage(assistantMessage.id, { content, state: 'failed' });
        yield eventLine({ type: 'run.failed', runId, error: message });
      }
    }

    reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no');
    return reply.send(Readable.from(generate()));
  });

  app.post('/api/conversations/:id/artifacts', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!db.getConversation(id)) return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });

    const file = await request.file();
    if (!file) return reply.status(400).send({ error: 'FILE_REQUIRED' });

    const stored = await storeArtifact(id, file);
    const artifact = db.addArtifact({
      conversationId: id,
      messageId: null,
      ...stored,
    });
    return reply.status(201).send({ artifact });
  });

  app.get('/api/artifacts/:id/content', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const artifact = getArtifact(db, id);
    if (!artifact) return reply.status(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    reply.header('Content-Type', artifact.mimeType);
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(createReadStream(artifact.storagePath));
  });

  app.get('/api/artifacts/:id/download', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const artifact = getArtifact(db, id);
    if (!artifact) return reply.status(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    reply.header('Content-Type', artifact.mimeType);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
    return reply.send(createReadStream(artifact.storagePath));
  });

  return app;
}

async function start() {
  const app = buildApp();
  const port = Number(process.env.CHAT_API_PORT ?? 4174);
  await app.listen({ host: '0.0.0.0', port });
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
