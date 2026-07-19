import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';

process.env.NODE_ENV = 'test';

describe('response regeneration with original attachments', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-retry-artifact-'));
    delete process.env.HERMES_BASE_URL;
    delete process.env.LETTA_BASE_URL;
    vi.resetModules();
    const { buildApp } = await import('./index.js');
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    vi.resetModules();
  });

  it('reuses the source attachment without duplicating the user message or attachment ownership', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Retry attachment QA' },
    });
    const conversationId = created.json().conversation.id as string;

    const boundary = '----retry-artifact-boundary';
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source-note.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8'),
      Buffer.from('RETRY_ATTACHMENT_ONLY_MARKER', 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/artifacts`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(uploaded.statusCode).toBe(201);
    const artifactId = uploaded.json().artifact.id as string;

    const original = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: {
        content: '첨부 문서를 읽어주세요.',
        artifactIds: [artifactId],
      },
    });
    expect(original.statusCode).toBe(200);
    const originalEvents = original.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    const originalCompleted = originalEvents.find((event) => event.type === 'run.completed');
    expect(originalCompleted?.type).toBe('run.completed');
    const assistantMessageId = originalCompleted?.type === 'run.completed' ? originalCompleted.message.id : '';

    const regenerated = await app.inject({
      method: 'POST',
      url: `/api/messages/${assistantMessageId}/retry/stream`,
      payload: {
        mode: 'regenerate',
        idempotencyKey: `regenerate-artifact-${crypto.randomUUID()}`,
      },
    });
    expect(regenerated.statusCode).toBe(200);
    const events = regenerated.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);

    expect(events.some((event) => event.type === 'message.accepted')).toBe(false);
    expect(events.some((event) => event.type === 'artifacts.attached')).toBe(false);
    const deliveries = events.filter((event) => event.type === 'artifacts.delivery');
    expect(deliveries.map((event) => event.type === 'artifacts.delivery' ? event.delivery.state : null))
      .toEqual(['delivering', 'delivered']);
    expect(deliveries.every((event) => event.type !== 'artifacts.delivery' || event.delivery.artifactIds[0] === artifactId)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    const conversation = detail.json().conversation as {
      messages: Array<{ id: string; role: string }>;
      artifacts: Array<{ id: string; messageId: string | null }>;
    };
    const users = conversation.messages.filter((message) => message.role === 'user');
    const assistants = conversation.messages.filter((message) => message.role === 'assistant');
    expect(users).toHaveLength(1);
    expect(assistants).toHaveLength(2);
    expect(conversation.artifacts).toEqual([
      expect.objectContaining({ id: artifactId, messageId: users[0].id }),
    ]);
  });
});
