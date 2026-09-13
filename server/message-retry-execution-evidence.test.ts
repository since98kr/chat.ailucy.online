import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';
import { ChatDatabase } from './database.js';

process.env.NODE_ENV = 'test';

let server: Server | null = null;
let app: FastifyInstance | null = null;
let directory: string | null = null;

async function startServer(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function parseEvents(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

afterEach(async () => {
  if (app) await app.close();
  app = null;
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  server = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  delete process.env.LETTA_BASE_URL;
  delete process.env.LETTA_CHAT_PATH;
  delete process.env.LETTA_HEALTH_PATH;
  delete process.env.LETTA_PROTOCOL;
  delete process.env.LETTA_AGENT_ID;
  vi.resetModules();
});

describe('retry execution evidence boundary', () => {
  it('preserves a prior blocker without a receipt and gives each retry attempt a distinct ASCII-safe provider operation id', async () => {
    const operationIds: string[] = [];
    const baseUrl = await startServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      operationIds.push(String(request.headers['x-lucy-execution-operation-id'] ?? ''));
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"delta":"provider commentary only"}\n\n');
        response.end('data: [DONE]\n\n');
      });
    });

    process.env.LETTA_BASE_URL = baseUrl;
    process.env.LETTA_CHAT_PATH = '/chat';
    process.env.LETTA_HEALTH_PATH = '/health';
    process.env.LETTA_PROTOCOL = 'native';
    process.env.LETTA_AGENT_ID = '[OpenClaw] Lucy';
    delete process.env.HERMES_BASE_URL;

    directory = mkdtempSync(join(tmpdir(), 'chat-v2-retry-evidence-'));
    const databasePath = join(directory, 'chat.sqlite');
    vi.resetModules();
    const { buildApp } = await import('./index.js');
    app = buildApp({ databasePath, artifactRoot: join(directory, 'artifacts') });
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[OpenClaw] Lucy', title: 'Retry evidence QA' },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;

    const initial = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: 'EXECUTION_SOURCE', artifactIds: [] },
    });
    expect(initial.statusCode).toBe(200);
    const initialCompleted = parseEvents(initial.body).find((event) => event.type === 'run.completed');
    expect(initialCompleted?.type).toBe('run.completed');
    const assistantMessageId = initialCompleted?.type === 'run.completed' ? initialCompleted.message.id : '';

    const directDatabase = new ChatDatabase(databasePath);
    directDatabase.updateMessage(assistantMessageId, { state: 'failed' });
    directDatabase.recordConversationRunFailure(conversationId, 'prior-failure-run', 'Prior provider execution failed');
    const blockedBeforeRetry = directDatabase.getConversationOperatingContext(conversationId);
    expect(blockedBeforeRetry?.blocker?.blockerId).toBe('prior-failure-run');
    directDatabase.close();

    const firstKey = `재시도-a-${crypto.randomUUID()}`;
    const firstRetry = await app.inject({
      method: 'POST',
      url: `/api/messages/${assistantMessageId}/retry/stream`,
      payload: { mode: 'retry', idempotencyKey: firstKey },
    });
    expect(firstRetry.statusCode).toBe(200);
    expect(parseEvents(firstRetry.body).some((event) => event.type === 'run.completed')).toBe(true);

    const afterFirstDatabase = new ChatDatabase(databasePath);
    const afterFirst = afterFirstDatabase.getConversationOperatingContext(conversationId);
    expect(afterFirst?.blocker).toEqual(blockedBeforeRetry?.blocker);
    expect(afterFirst?.nextAction).toBe(blockedBeforeRetry?.nextAction);
    expect(afterFirst?.statusTruth).toEqual(blockedBeforeRetry?.statusTruth);
    afterFirstDatabase.close();

    const secondKey = `재시도-b-${crypto.randomUUID()}`;
    const secondRetry = await app.inject({
      method: 'POST',
      url: `/api/messages/${assistantMessageId}/retry/stream`,
      payload: { mode: 'retry', idempotencyKey: secondKey },
    });
    expect(secondRetry.statusCode).toBe(200);
    expect(parseEvents(secondRetry.body).some((event) => event.type === 'run.completed')).toBe(true);

    const retryOperationIds = operationIds.slice(-2);
    expect(retryOperationIds).toHaveLength(2);
    for (const operationId of retryOperationIds) {
      expect(operationId).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
      expect(operationId).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(retryOperationIds[0]).not.toContain(firstKey);
    expect(retryOperationIds[1]).not.toContain(secondKey);
    expect(retryOperationIds[0]).not.toContain('재시도');
    expect(retryOperationIds[1]).not.toContain('재시도');
    expect(retryOperationIds[0]).not.toBe(retryOperationIds[1]);

    const afterSecondDatabase = new ChatDatabase(databasePath);
    const afterSecond = afterSecondDatabase.getConversationOperatingContext(conversationId);
    expect(afterSecond?.blocker).toEqual(blockedBeforeRetry?.blocker);
    expect(afterSecond?.nextAction).toBe(blockedBeforeRetry?.nextAction);
    expect(afterSecond?.statusTruth).toEqual(blockedBeforeRetry?.statusTruth);
    afterSecondDatabase.close();
  });
});
