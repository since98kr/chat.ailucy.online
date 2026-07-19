import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';
import { ChatDatabase } from './database.js';

process.env.NODE_ENV = 'test';

describe('direct response retry and regeneration', () => {
  let directory: string;
  let databasePath: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-message-retry-'));
    databasePath = join(directory, 'chat.sqlite');
    delete process.env.HERMES_BASE_URL;
    delete process.env.LETTA_BASE_URL;
    vi.resetModules();
    const { buildApp } = await import('./index.js');
    app = buildApp({ databasePath, artifactRoot: join(directory, 'artifacts') });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    vi.resetModules();
  });

  async function createCompletedExchange() {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Retry QA' },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;
    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: 'RETRY_SOURCE_MARKER', artifactIds: [] },
    });
    expect(streamed.statusCode).toBe(200);
    const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    const completed = events.find((event) => event.type === 'run.completed');
    expect(completed?.type).toBe('run.completed');
    return {
      conversationId,
      assistantMessageId: completed?.type === 'run.completed' ? completed.message.id : '',
    };
  }

  it('regenerates one assistant response without duplicating the source user message', async () => {
    const { conversationId, assistantMessageId } = await createCompletedExchange();
    const retryRejected = await app.inject({
      method: 'POST',
      url: `/api/messages/${assistantMessageId}/retry/stream`,
      payload: { mode: 'retry', idempotencyKey: 'retry-complete-rejected' },
    });
    expect(retryRejected.statusCode).toBe(409);
    expect(retryRejected.json().error).toBe('RETRY_REQUIRES_FAILED_OR_CANCELLED_RESPONSE');

    const key = `regenerate-${crypto.randomUUID()}`;
    const regenerated = await app.inject({
      method: 'POST',
      url: `/api/messages/${assistantMessageId}/retry/stream`,
      payload: { mode: 'regenerate', idempotencyKey: key },
    });
    expect(regenerated.statusCode).toBe(200);
    const events = regenerated.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    expect(events.some((event) => event.type === 'message.accepted')).toBe(false);
    const newMessage = events.find((event) => event.type === 'message.created');
    expect(newMessage?.type).toBe('message.created');

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    const messages = detail.json().conversation.messages as Array<{
      id: string;
      role: string;
      authorId: string;
      parentMessageId: string | null;
      content: string;
    }>;
    const users = messages.filter((message) => message.role === 'user');
    const assistants = messages.filter((message) => message.role === 'assistant');
    expect(users).toHaveLength(1);
    expect(assistants).toHaveLength(2);
    expect(assistants[0].id).toBe(assistantMessageId);
    expect(assistants[1]).toMatchObject({
      authorId: assistants[0].authorId,
      parentMessageId: users[0].id,
    });
    expect(assistants[0].content).not.toBe('');
    expect(assistants[1].content).not.toBe('');

    const replayed = await app.inject({
      method: 'POST',
      url: `/api/messages/${assistantMessageId}/retry/stream`,
      payload: { mode: 'regenerate', idempotencyKey: key },
    });
    expect(replayed.statusCode).toBe(200);
    const replayEvents = replayed.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    expect(replayEvents.map((event) => event.type)).toEqual(['message.created', 'run.completed']);

    const afterReplay = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    expect((afterReplay.json().conversation.messages as unknown[])).toHaveLength(messages.length);
  });

  it('retries a failed response and records the original-to-new lineage', async () => {
    const { conversationId, assistantMessageId } = await createCompletedExchange();
    const directDatabase = new ChatDatabase(databasePath);
    directDatabase.updateMessage(assistantMessageId, { state: 'failed' });
    directDatabase.close();

    const key = `retry-${crypto.randomUUID()}`;
    const retried = await app.inject({
      method: 'POST',
      url: `/api/messages/${assistantMessageId}/retry/stream`,
      payload: { mode: 'retry', idempotencyKey: key },
    });
    expect(retried.statusCode).toBe(200);
    const events = retried.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    const completed = events.find((event) => event.type === 'run.completed');
    expect(completed?.type).toBe('run.completed');

    const auditDatabase = new ChatDatabase(databasePath);
    const retry = auditDatabase.db.prepare(`
      SELECT original_message_id, source_message_id, output_message_id, mode, status
      FROM message_retry_attempts WHERE idempotency_key = ?
    `).get(key) as Record<string, unknown>;
    auditDatabase.close();
    expect(retry).toMatchObject({
      original_message_id: assistantMessageId,
      output_message_id: completed?.type === 'run.completed' ? completed.message.id : '',
      mode: 'retry',
      status: 'completed',
    });

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    const messages = detail.json().conversation.messages as Array<{ role: string }>;
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
  });
});
