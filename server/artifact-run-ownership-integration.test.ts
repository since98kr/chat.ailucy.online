import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';
import { ChatDatabase } from './database.js';

process.env.NODE_ENV = 'test';

describe('generated artifact run/task ownership integration', () => {
  let directory: string;
  let backend: Server;
  let app: FastifyInstance;
  let databasePath: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-artifact-run-owner-'));
    databasePath = join(directory, 'chat.sqlite');
    backend = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write(`${JSON.stringify({
          type: 'artifact.created',
          artifact: {
            filename: 'owned-result.txt',
            mime_type: 'text/plain',
            content_text: 'OWNED_RESULT',
          },
        })}\n`);
        response.end('{"delta":"done"}\n');
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const address = backend.address() as AddressInfo;

    process.env.HERMES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.HERMES_CHAT_PATH = '/v1/chat/completions';
    process.env.HERMES_HEALTH_PATH = '/health';
    process.env.HERMES_PROTOCOL = 'openai';
    process.env.HERMES_MODEL_MAP_JSON = '{"[Hermes] Lucy":"artifact-owner-model"}';
    vi.resetModules();
    const { buildApp } = await import('./index.js');
    app = buildApp({ databasePath, artifactRoot: join(directory, 'artifacts') });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
    delete process.env.HERMES_BASE_URL;
    delete process.env.HERMES_CHAT_PATH;
    delete process.env.HERMES_HEALTH_PATH;
    delete process.env.HERMES_PROTOCOL;
    delete process.env.HERMES_MODEL_MAP_JSON;
    vi.resetModules();
  });

  it('persists the exact producing run and bound task across reload', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Artifact owner integration' },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: 'Generate an owned artifact', artifactIds: [] },
    });
    expect(streamed.statusCode).toBe(200);
    const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    const accepted = events.find((event) => event.type === 'message.accepted');
    const started = events.find((event) => event.type === 'run.started');
    const createdArtifact = events.find((event) => event.type === 'artifact.created');
    expect(accepted?.type).toBe('message.accepted');
    expect(started?.type).toBe('run.started');
    expect(createdArtifact?.type).toBe('artifact.created');
    if (accepted?.type !== 'message.accepted' || started?.type !== 'run.started' || createdArtifact?.type !== 'artifact.created') {
      throw new Error('Expected message.accepted, run.started, and artifact.created events');
    }

    expect(createdArtifact.artifact.producerRunId).toBe(started.runId);
    expect(createdArtifact.artifact.producerTaskId).toBe(accepted.message.id);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    expect(detail.statusCode).toBe(200);
    const persisted = detail.json().conversation.artifacts.find(
      (artifact: { id: string }) => artifact.id === createdArtifact.artifact.id,
    );
    expect(persisted).toMatchObject({
      producerRunId: started.runId,
      producerTaskId: accepted.message.id,
      messageId: createdArtifact.artifact.messageId,
    });

    const reopened = new ChatDatabase(databasePath);
    expect(reopened.getArtifact(createdArtifact.artifact.id)).toMatchObject({
      conversationId,
      producerRunId: started.runId,
      producerTaskId: accepted.message.id,
      messageId: createdArtifact.artifact.messageId,
    });
    reopened.close();
  });
});
