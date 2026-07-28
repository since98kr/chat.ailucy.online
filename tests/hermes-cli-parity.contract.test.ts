import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operationIdentity, sessionIdentity } from '../server/collaboration-runner.js';
import type { CollaborationRunInput } from '../server/collaboration-runner.js';
import type { ConversationRecord } from '../shared/contracts.js';

type BackendRequest = {
  agent_id: string;
  conversation_id: string;
  session_id: string;
  idempotency_key: string;
  runtime: { provider: string; model: string; selected_agent_id: string };
  messages: Array<{ author_id: string; content: string }>;
  participants: Array<{ agent_id: string; capabilities: string[] }>;
  metadata: { user_message_id: string; target_agent_id: string };
};

describe('Hermes CLI parity and approved subagent conversation contracts', () => {
  let server: Server | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    delete process.env.HERMES_BASE_URL;
    delete process.env.HERMES_PROVIDER;
    delete process.env.HERMES_MODEL_MAP_JSON;
    delete process.env.HERMES_API_KEY;
    vi.resetModules();
    if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    server = undefined;
    directory = undefined;
  });

  it('scopes caller identities to the selected agent and keeps retries stable', () => {
    const conversation = { id: 'conversation-scope-test', systemId: 'hermes' } as ConversationRecord;
    const input = {
      idempotencyKey: 'caller-operation-001',
      userMessage: { id: 'message-001' },
    } as CollaborationRunInput;
    const xixiSession = sessionIdentity(conversation, 'Xixi', 'caller-session-001');
    const lynnSession = sessionIdentity(conversation, 'Lynn', 'caller-session-001');
    const xixiOperation = operationIdentity(input, 'Xixi', xixiSession);

    expect(xixiSession).not.toBe(lynnSession);
    expect(xixiOperation).not.toBe(operationIdentity(input, 'Lynn', lynnSession));
    expect(sessionIdentity(conversation, 'Xixi', 'caller-session-001')).toBe(xixiSession);
    expect(operationIdentity(input, 'Xixi', xixiSession)).toBe(xixiOperation);
  });

  it('executes one authenticated Hermes session with capability-scoped agents, runtime identity, and isolated subagent histories', async () => {
    const requests: BackendRequest[] = [];
    let authenticatedRequests = 0;
    server = createServer((request, response) => {
      if (request.headers.authorization) authenticatedRequests += 1;
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
    process.env.HERMES_API_KEY = '<redacted-contract-auth>';
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
      expect(authenticatedRequests).toBe(3);
      expect(requests.map((item) => item.conversation_id)).toEqual([conversationId, conversationId, conversationId]);
      expect(requests.map((item) => item.session_id)).toEqual([
        `hermes:${conversationId}:Xixi`,
        `hermes:${conversationId}:Lynn`,
        `hermes:${conversationId}:[Hermes] Lucy`,
      ]);
      expect(new Set(requests.map((item) => item.idempotency_key)).size).toBe(3);
      expect(requests.map((item) => item.metadata)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target_agent_id: 'implementation-runtime-model', user_message_id: expect.any(String) }),
        expect.objectContaining({ target_agent_id: 'review-runtime-model', user_message_id: expect.any(String) }),
        expect.objectContaining({ target_agent_id: 'lucy-runtime-model', user_message_id: expect.any(String) }),
      ]));
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
      expect(requests[0].participants[0].capabilities).toEqual(expect.arrayContaining(['implementation', 'coding']));
      expect(requests[1].participants[0].capabilities).toEqual(expect.arrayContaining(['review', 'verification']));
      expect(requests[2].participants).toEqual(expect.arrayContaining([
        expect.objectContaining({ agent_id: '[Hermes] Lucy', capabilities: expect.arrayContaining(['orchestration']) }),
        expect.objectContaining({ agent_id: 'Xixi', capabilities: expect.arrayContaining(['implementation']) }),
        expect.objectContaining({ agent_id: 'Lynn', capabilities: expect.arrayContaining(['review']) }),
      ]));
    } finally {
      await app.close();
    }
  }, 15_000);

  it('persists a generated session artifact through a sanitized lifecycle without exposing storage or authentication details', async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write(`${JSON.stringify({
          type: 'artifact.created',
          artifact: {
            filename: 'session-summary.txt',
            mime_type: 'text/plain',
            content_text: 'SANITIZED_ARTIFACT_MARKER',
          },
        })}\n`);
        response.end(`${JSON.stringify({ delta: 'session complete' })}\n`);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    process.env.HERMES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.HERMES_PROVIDER = 'hermes-cli';
    process.env.HERMES_MODEL_MAP_JSON = JSON.stringify({ '[Hermes] Lucy': 'lucy-runtime-model' });
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
        payload: { content: 'Create the session summary.' },
      });
      expect(streamed.statusCode).toBe(200);
      const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line) as {
        type: string;
        artifact?: { id: string; filename: string; mimeType: string; messageId: string | null };
      });
      const generated = events.find((event) => event.type === 'artifact.created')?.artifact;
      expect(generated).toMatchObject({
        id: expect.any(String), filename: 'session-summary.txt', mimeType: 'text/plain', messageId: expect.any(String),
      });
      expect(streamed.body).not.toContain(directory);
      expect(streamed.body).not.toContain('storagePath');
      expect(streamed.body).not.toContain('authorization');

      const downloaded = await app.inject({ method: 'GET', url: `/api/artifacts/${generated?.id}/download` });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.rawPayload).toEqual(Buffer.from('SANITIZED_ARTIFACT_MARKER', 'utf8'));
    } finally {
      await app.close();
    }
  });
});
