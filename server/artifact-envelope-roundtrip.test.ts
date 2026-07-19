import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';

process.env.NODE_ENV = 'test';

describe('Hermes artifact envelope roundtrip', () => {
  let directory: string;
  let backend: Server;
  let app: FastifyInstance;
  let receivedBody: Record<string, unknown> = {};

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-artifact-envelope-roundtrip-'));
    backend = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const deltas = [
          'event: hermes.tool.progress',
          '파일을 준비했습니다.\n',
          '<CHAT_V2_ART',
          'IFACT>{"filename":"qa-result.txt","mime_type":"text/plain",',
          '"content_text":"ENVELOPE_ROUNDTRIP_MARKER"}</CHAT_V2_ARTIFACT>',
          '\n완료',
        ];
        for (const delta of deltas) {
          response.write(`${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n`);
        }
        response.end();
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const address = backend.address() as AddressInfo;

    process.env.HERMES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.HERMES_CHAT_PATH = '/v1/chat/completions';
    process.env.HERMES_HEALTH_PATH = '/health';
    process.env.HERMES_PROTOCOL = 'openai';
    process.env.HERMES_MODEL_MAP_JSON = '{"[Hermes] Lucy":"lucy-model"}';
    process.env.HERMES_ARTIFACT_TOOL_ENABLED = 'true';
    process.env.HERMES_ARTIFACT_ENVELOPE_ENABLED = 'true';
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
    delete process.env.HERMES_ARTIFACT_TOOL_ENABLED;
    delete process.env.HERMES_ARTIFACT_ENVELOPE_ENABLED;
    vi.resetModules();
  });

  it('persists and downloads an inline envelope file while hiding protocol markup and internal progress', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Envelope roundtrip' },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: 'qa-result.txt 파일을 반환하세요.', artifactIds: [] },
    });
    expect(streamed.statusCode).toBe(200);
    const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    const artifactEvent = events.find((event) => event.type === 'artifact.created');
    expect(artifactEvent?.type).toBe('artifact.created');
    if (artifactEvent?.type !== 'artifact.created') throw new Error('artifact.created was not emitted');
    expect(artifactEvent.artifact).toMatchObject({
      filename: 'qa-result.txt',
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength('ENVELOPE_ROUNDTRIP_MARKER'),
    });

    const visibleText = events
      .filter((event) => event.type === 'content.delta')
      .map((event) => event.type === 'content.delta' ? event.delta : '')
      .join('');
    expect(visibleText).toBe('파일을 준비했습니다.\n\n완료');
    expect(visibleText).not.toContain('CHAT_V2_ARTIFACT');
    expect(visibleText).not.toContain('hermes.tool.progress');

    const messages = receivedBody.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0].content).toContain('<CHAT_V2_ARTIFACT>');
    expect(receivedBody.tools).toEqual(expect.any(Array));

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    expect(detail.statusCode).toBe(200);
    const conversation = detail.json().conversation as {
      messages: Array<{ role: string; content: string }>;
      artifacts: Array<{ id: string; filename: string; messageId: string | null }>;
    };
    const assistant = conversation.messages.find((message) => message.role === 'assistant');
    expect(assistant?.content).toBe('파일을 준비했습니다.\n\n완료');
    const artifact = conversation.artifacts.find((item) => item.filename === 'qa-result.txt');
    expect(artifact?.messageId).toBeTruthy();

    const downloaded = await app.inject({ method: 'GET', url: `/api/artifacts/${artifact?.id}/download` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(Buffer.from('ENVELOPE_ROUNDTRIP_MARKER', 'utf8'));
  });
});
