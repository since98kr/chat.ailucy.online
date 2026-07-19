import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';

process.env.NODE_ENV = 'test';

describe('artifact AI roundtrip', () => {
  let directory: string;
  let backend: Server;
  let app: FastifyInstance;
  let receivedRequest: Record<string, unknown> = {};

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-artifact-roundtrip-'));
    backend = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write(`${JSON.stringify({
          type: 'artifact.created',
          artifact: {
            filename: 'ai-result.txt',
            mime_type: 'text/plain',
            content_text: 'AI_GENERATED_FILE_MARKER_49',
          },
        })}\n`);
        response.end('{"delta":"DOCUMENT_MARKER_RECEIVED"}\n');
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const address = backend.address() as AddressInfo;

    process.env.HERMES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.HERMES_CHAT_PATH = '/v1/chat/completions';
    process.env.HERMES_HEALTH_PATH = '/health';
    process.env.HERMES_PROTOCOL = 'openai';
    process.env.HERMES_MODEL_MAP_JSON = '{"[Hermes] Lucy":"vision-model"}';
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
    await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
    delete process.env.HERMES_BASE_URL;
    delete process.env.HERMES_CHAT_PATH;
    delete process.env.HERMES_HEALTH_PATH;
    delete process.env.HERMES_PROTOCOL;
    delete process.env.HERMES_MODEL_MAP_JSON;
    vi.resetModules();
  });

  it('delivers document-only context and persists an AI-generated file', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Artifact roundtrip' },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;

    const boundary = '----chat-v2-artifact-test';
    const note = Buffer.from('DOCUMENT_ONLY_MARKER_7C11', 'utf8');
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="marker.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8'),
      note,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/artifacts`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(uploaded.statusCode).toBe(201);
    const inputArtifactId = uploaded.json().artifact.id as string;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: {
        content: '첨부 문서에만 있는 마커를 확인하고 결과 파일을 반환하세요.',
        artifactIds: [inputArtifactId],
      },
    });
    expect(streamed.statusCode).toBe(200);
    const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    const deliveries = events.filter((event) => event.type === 'artifacts.delivery');
    expect(deliveries.map((event) => event.type === 'artifacts.delivery' ? event.delivery.state : null))
      .toEqual(['delivering', 'delivered']);
    expect(deliveries[0]).toMatchObject({
      type: 'artifacts.delivery',
      delivery: {
        messageId: expect.any(String),
        agentId: '[Hermes] Lucy',
        systemId: 'hermes',
        artifactIds: [inputArtifactId],
      },
    });
    expect(deliveries[1]).toMatchObject({
      type: 'artifacts.delivery',
      delivery: {
        state: 'delivered',
        detail: expect.stringContaining('model understanding is verified separately'),
      },
    });

    const generatedEvent = events.find((event) => event.type === 'artifact.created');
    expect(generatedEvent?.type).toBe('artifact.created');
    expect(events.some((event) => event.type === 'content.delta' && event.delta.includes('DOCUMENT_MARKER_RECEIVED'))).toBe(true);

    const messages = receivedRequest.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    const currentContent = messages.at(-1)?.content;
    expect(typeof currentContent).toBe('string');
    expect(currentContent).toContain('DOCUMENT_ONLY_MARKER_7C11');

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    expect(detail.statusCode).toBe(200);
    const conversation = detail.json().conversation as {
      messages: Array<{ id: string; role: string }>;
      artifacts: Array<{ id: string; messageId: string | null; filename: string; sizeBytes: number }>;
    };
    const assistant = conversation.messages.find((message) => message.role === 'assistant');
    const generated = conversation.artifacts.find((artifact) => artifact.filename === 'ai-result.txt');
    expect(generated).toMatchObject({
      messageId: assistant?.id,
      sizeBytes: Buffer.byteLength('AI_GENERATED_FILE_MARKER_49'),
    });

    const downloaded = await app.inject({ method: 'GET', url: `/api/artifacts/${generated?.id}/download` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(Buffer.from('AI_GENERATED_FILE_MARKER_49', 'utf8'));
  });
});
