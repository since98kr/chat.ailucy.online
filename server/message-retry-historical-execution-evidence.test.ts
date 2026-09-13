import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';
import { ChatDatabase } from './database.js';

process.env.NODE_ENV = 'test';

function parseEvents(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

describe('historical retry execution evidence boundary', () => {
  let server: Server | null = null;
  let app: FastifyInstance | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    if (app) await app.close();
    if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
    app = null;
    server = null;
    directory = null;
    delete process.env.LETTA_BASE_URL;
    delete process.env.LETTA_CHAT_PATH;
    delete process.env.LETTA_HEALTH_PATH;
    delete process.env.LETTA_PROTOCOL;
    delete process.env.LETTA_AGENT_ID;
    vi.resetModules();
  });

  it('does not let a valid receipt for an older retry clear a newer task blocker', async () => {
    let emitReceipt = false;
    server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      const sessionId = String(request.headers['x-lucy-execution-session-id'] ?? '');
      const operationId = String(request.headers['x-lucy-execution-operation-id'] ?? '');
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"delta":"provider result"}\n\n');
        if (emitReceipt) {
          response.write(`data: ${JSON.stringify({
            type: 'execution-evidence',
            evidence: {
              kind: 'result-receipt',
              sessionId,
              operationId,
              receiptId: 'historical-retry-receipt',
            },
          })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    process.env.LETTA_BASE_URL = baseUrl;
    process.env.LETTA_CHAT_PATH = '/chat';
    process.env.LETTA_HEALTH_PATH = '/health';
    process.env.LETTA_PROTOCOL = 'native';
    process.env.LETTA_AGENT_ID = '[OpenClaw] Lucy';
    delete process.env.HERMES_BASE_URL;

    directory = mkdtempSync(join(tmpdir(), 'chat-v2-historical-retry-'));
    const databasePath = join(directory, 'chat.sqlite');
    vi.resetModules();
    const { buildApp } = await import('./index.js');
    app = buildApp({ databasePath, artifactRoot: join(directory, 'artifacts') });
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[OpenClaw] Lucy', title: 'Historical retry guard' },
    });
    const conversationId = created.json().conversation.id as string;

    const older = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: 'OLDER_EXECUTION_TASK', artifactIds: [] },
    });
    const olderEvents = parseEvents(older.body);
    const olderAccepted = olderEvents.find((event) => event.type === 'message.accepted');
    const olderCompleted = olderEvents.find((event) => event.type === 'run.completed');
    expect(olderAccepted?.type).toBe('message.accepted');
    expect(olderCompleted?.type).toBe('run.completed');
    if (olderAccepted?.type !== 'message.accepted' || olderCompleted?.type !== 'run.completed') {
      throw new Error('Expected older source task and response');
    }

    const newer = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: 'NEWER_ACTIVE_TASK', artifactIds: [] },
    });
    const newerAccepted = parseEvents(newer.body).find((event) => event.type === 'message.accepted');
    expect(newerAccepted?.type).toBe('message.accepted');
    if (newerAccepted?.type !== 'message.accepted') throw new Error('Expected newer active task');

    const database = new ChatDatabase(databasePath);
    database.updateMessage(olderCompleted.message.id, { state: 'failed' });
    database.recordConversationRunFailure(conversationId, 'newer-task-failure', 'Newer active task is blocked');
    const beforeRetry = database.getConversationOperatingContext(conversationId)!;
    expect(beforeRetry.activeTask?.taskId).toBe(newerAccepted.message.id);
    expect(beforeRetry.activeTask?.taskId).not.toBe(olderAccepted.message.id);
    expect(beforeRetry.blocker?.blockerId).toBe('newer-task-failure');
    database.close();

    emitReceipt = true;
    const retried = await app.inject({
      method: 'POST',
      url: `/api/messages/${olderCompleted.message.id}/retry/stream`,
      payload: { mode: 'retry', idempotencyKey: `historical-${crypto.randomUUID()}` },
    });
    expect(retried.statusCode).toBe(200);
    expect(parseEvents(retried.body).some((event) => event.type === 'run.completed')).toBe(true);

    const afterDatabase = new ChatDatabase(databasePath);
    const afterRetry = afterDatabase.getConversationOperatingContext(conversationId)!;
    expect(afterRetry.activeTask).toEqual(beforeRetry.activeTask);
    expect(afterRetry.blocker).toEqual(beforeRetry.blocker);
    expect(afterRetry.nextAction).toBe(beforeRetry.nextAction);
    expect(afterRetry.statusTruth).toEqual(beforeRetry.statusTruth);
    afterDatabase.close();
  });
});
