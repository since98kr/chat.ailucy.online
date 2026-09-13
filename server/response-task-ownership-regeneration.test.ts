import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';

process.env.NODE_ENV = 'test';

function events(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

describe('response task ownership across regeneration', () => {
  let directory: string;
  let backend: Server;
  let app: FastifyInstance;
  let backendTurn = 0;

  async function openApp() {
    vi.resetModules();
    const { buildApp } = await import('./index.js');
    const next = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await next.ready();
    return next;
  }

  beforeEach(async () => {
    backendTurn = 0;
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-response-task-owner-'));
    backend = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      request.resume();
      request.on('end', () => {
        backendTurn += 1;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        // The original response and a newer task intentionally produce no
        // artifact. Only regeneration creates the first artifact for the old
        // response, which must still inherit the old response's durable task.
        if (backendTurn === 3) {
          response.write(`${JSON.stringify({
            type: 'artifact.created',
            artifact: {
              filename: 'regenerated-first-artifact.txt',
              mime_type: 'text/plain',
              content_text: 'REGENERATED_FIRST_ARTIFACT',
            },
          })}\n`);
        }
        response.end('{"delta":"done"}\n');
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const address = backend.address() as AddressInfo;
    process.env.HERMES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.HERMES_CHAT_PATH = '/v1/chat/completions';
    process.env.HERMES_HEALTH_PATH = '/health';
    process.env.HERMES_PROTOCOL = 'openai';
    process.env.HERMES_MODEL_MAP_JSON = JSON.stringify({ '[Hermes] Lucy': 'response-owner-model' });
    delete process.env.LETTA_BASE_URL;
    app = await openApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
    delete process.env.HERMES_BASE_URL;
    delete process.env.HERMES_CHAT_PATH;
    delete process.env.HERMES_HEALTH_PATH;
    delete process.env.HERMES_PROTOCOL;
    delete process.env.HERMES_MODEL_MAP_JSON;
    vi.resetModules();
  });

  it('replays the source response task even when that response emitted zero artifacts', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Response ownership proof' },
    });
    const conversationId = created.json().conversation.id as string;

    const original = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: '원래 작업을 실행해.', artifactIds: [] },
    });
    expect(original.statusCode).toBe(200);
    const originalEvents = events(original.body);
    const originalAccepted = originalEvents.find((event) => event.type === 'message.accepted');
    const originalCompleted = originalEvents.find(
      (event) => event.type === 'run.completed' && event.agentId === '[Hermes] Lucy',
    );
    expect(originalAccepted?.type).toBe('message.accepted');
    expect(originalCompleted?.type).toBe('run.completed');
    expect(originalEvents.some((event) => event.type === 'artifact.created')).toBe(false);
    if (originalAccepted?.type !== 'message.accepted' || originalCompleted?.type !== 'run.completed') {
      throw new Error('Expected original task and completed response');
    }

    const newer = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: '이건 더 최신의 별도 작업이다.', artifactIds: [] },
    });
    expect(newer.statusCode).toBe(200);
    const newerAccepted = events(newer.body).find((event) => event.type === 'message.accepted');
    expect(newerAccepted?.type).toBe('message.accepted');
    if (newerAccepted?.type !== 'message.accepted') throw new Error('Expected newer task');
    expect(newerAccepted.message.id).not.toBe(originalAccepted.message.id);

    // Re-open the app on the same SQLite file to prove the source response task
    // ownership is durable, not an in-memory retry convenience.
    await app.close();
    app = await openApp();

    const retried = await app.inject({
      method: 'POST',
      url: `/api/messages/${originalCompleted.message.id}/retry/stream`,
      payload: { mode: 'regenerate', idempotencyKey: `first-artifact-retry-${crypto.randomUUID()}` },
    });
    expect(retried.statusCode).toBe(200);
    const retryEvents = events(retried.body);
    const retryArtifact = retryEvents.find((event) => event.type === 'artifact.created');
    expect(retryArtifact?.type).toBe('artifact.created');
    if (retryArtifact?.type !== 'artifact.created') throw new Error('Expected regenerated first artifact');
    expect(retryArtifact.artifact.producerTaskId).toBe(originalAccepted.message.id);
    expect(retryArtifact.artifact.producerTaskId).not.toBe(newerAccepted.message.id);
  });
});
