import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type BackendRequest = {
  agent_id: string;
  runtime: { provider: string; model: string; selected_agent_id: string };
  messages: Array<{ author_id: string; content: string }>;
  participants: Array<{ agent_id: string; capabilities: string[] }>;
};

describe('Hermes CLI parity and approved subagent conversation contracts', () => {
  let server: Server | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    delete process.env.HERMES_BASE_URL;
    delete process.env.HERMES_PROVIDER;
    delete process.env.HERMES_MODEL_MAP_JSON;
    vi.resetModules();
    if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    server = undefined;
    directory = undefined;
  });

  it('binds a Hermes provider, model, and selected agent per turn without leaking sibling subagent histories', async () => {
    const requests: BackendRequest[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BackendRequest;
        requests.push(body);
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end(`${JSON.stringify({ delta: `${body.agent_id}-output` })}\n`);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    process.env.HERMES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.HERMES_PROVIDER = 'hermes-cli';
    process.env.HERMES_MODEL_MAP_JSON = JSON.stringify({
      '[Hermes] Lucy': 'lucy-runtime-model',
      Xixi: 'implementation-runtime-model',
      Lynn: 'review-runtime-model',
    });
    vi.resetModules();
    const { buildApp } = await import('../server/index.js');
    directory = await mkdtemp(join(tmpdir(), 'chat-v2-hermes-parity-'));
    const app = buildApp({ databasePath: join(directory, 'chat.sqlite'), artifactRoot: join(directory, 'artifacts') });
    await app.ready();

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'hermes', agentId: '[Hermes] Lucy' },
      });
      const conversationId = created.json().conversation.id as string;
      const streamed = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages/stream`,
        payload: { content: '@Xixi 구현하고 @Lynn 검토해줘.' },
      });
      expect(streamed.statusCode).toBe(200);

      expect(requests.map((item) => item.agent_id)).toEqual([
        'implementation-runtime-model',
        'review-runtime-model',
        'lucy-runtime-model',
      ]);
      expect(requests.map((item) => item.runtime)).toEqual([
        { provider: 'hermes-cli', model: 'implementation-runtime-model', selected_agent_id: 'Xixi' },
        { provider: 'hermes-cli', model: 'review-runtime-model', selected_agent_id: 'Lynn' },
        { provider: 'hermes-cli', model: 'lucy-runtime-model', selected_agent_id: '[Hermes] Lucy' },
      ]);
      expect(requests[0].messages.map((message) => message.content)).not.toContain('review-runtime-model-output');
      expect(requests[1].messages.map((message) => message.content)).not.toContain('implementation-runtime-model-output');
      expect(requests[2].messages.map((message) => message.content)).toEqual(expect.arrayContaining([
        'implementation-runtime-model-output',
        'review-runtime-model-output',
      ]));
      expect(requests.map((item) => item.participants.map((participant) => participant.agent_id))).toEqual([
        ['Xixi'],
        ['Lynn'],
        ['[Hermes] Lucy', 'Xixi', 'Lynn'],
      ]);
    } finally {
      await app.close();
    }
  });
});
