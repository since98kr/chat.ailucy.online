import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ConversationParticipantRecord,
  ConversationRecord,
  MessageRecord,
} from '../../shared/contracts.js';
import { OpenClawLettaAdapter } from './openclaw-letta.js';

const timestamp = '2026-08-08T00:00:00.000Z';
const conversation: ConversationRecord = {
  id: 'conversation-1',
  systemId: 'letta',
  agentId: '[Letta] Lucy',
  title: 'OpenClaw transport',
  preview: '',
  status: 'active',
  pinned: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastReadMessageId: null,
  draft: '',
  branchedFromConversationId: null,
  branchedFromMessageId: null,
};
const oldMessage: MessageRecord = {
  id: 'message-old',
  conversationId: conversation.id,
  role: 'user',
  authorId: 'tei',
  content: '이전 질문',
  state: 'complete',
  parentMessageId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const oldAnswer: MessageRecord = {
  id: 'message-answer',
  conversationId: conversation.id,
  role: 'assistant',
  authorId: '[Letta] Lucy',
  content: '이전 답변',
  state: 'complete',
  parentMessageId: oldMessage.id,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const userMessage: MessageRecord = {
  id: 'message-current',
  conversationId: conversation.id,
  role: 'user',
  authorId: 'tei',
  content: '현재 질문',
  state: 'complete',
  parentMessageId: oldAnswer.id,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const participant: ConversationParticipantRecord = {
  conversationId: conversation.id,
  agentId: '[Letta] Lucy',
  role: 'lead',
  state: 'active',
  addedAt: timestamp,
  updatedAt: timestamp,
  agent: {
    id: '[Letta] Lucy',
    systemId: 'letta',
    displayName: '[Letta] Lucy',
    shortName: 'Lucy',
    role: 'Primary Cognitive Agent',
    description: '',
    capabilities: ['memory', 'planning', 'orchestration'],
    enabled: true,
    directChatEnabled: true,
    isLead: true,
    sortOrder: 10,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
};

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  server = null;
});

async function startServer(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function adapter(baseUrl: string) {
  return new OpenClawLettaAdapter({
    baseUrl,
    chatPath: '/v1/chat/completions',
    healthPath: '/health',
    apiKey: 'gateway-secret',
    agentTarget: 'openclaw/lucy',
    sessionPrefix: 'chat-v2',
    timeoutMs: 2_000,
    maxArtifactBytes: 10 * 1024 * 1024,
    maxArtifactTotalBytes: 20 * 1024 * 1024,
    artifactToolEnabled: false,
  });
}

describe('OpenClawLettaAdapter', () => {
  it('preserves Letta identity while routing a stable Chat conversation to an OpenClaw agent session', async () => {
    let authorization = '';
    let receivedBody: Record<string, unknown> = {};
    const baseUrl = await startServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true,"status":"live"}');
        return;
      }
      authorization = String(request.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"OpenClaw를 통해 "}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"Letta Lucy 응답"}}]}\n\n');
        response.end('data: [DONE]\n\n');
      });
    });

    const openClaw = adapter(baseUrl);
    const health = await openClaw.health();
    expect(health).toMatchObject({ ok: true, mode: 'http' });
    expect(health.detail).toContain('OpenClaw Gateway');

    const items = [];
    for await (const item of openClaw.streamReply({
      conversation,
      userMessage,
      history: [oldMessage, oldAnswer, userMessage],
      targetAgentId: '[Letta] Lucy',
      selectedAgentId: '[Letta] Lucy',
      routingMode: 'direct',
      participants: [participant],
      sessionId: 'legacy-chat-session-id-is-not-the-openclaw-key',
      idempotencyKey: 'operation-1',
    })) items.push(item);

    expect(authorization).toBe('Bearer gateway-secret');
    expect(receivedBody.model).toBe('openclaw/lucy');
    expect(receivedBody.user).toBe('chat-v2:conversation-1');
    expect(receivedBody.stream).toBe(true);
    expect(receivedBody).not.toHaveProperty('system_id');
    expect(receivedBody).not.toHaveProperty('agent_id');
    expect(receivedBody.messages).toEqual([{ role: 'user', content: '현재 질문' }]);
    expect(items).toEqual([
      { type: 'delta', delta: 'OpenClaw를 통해 ' },
      { type: 'delta', delta: 'Letta Lucy 응답' },
    ]);
  });

  it('fails closed on OpenClaw error frames without streaming them as assistant text', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"error":{"message":"approval continuation failed"}}\n\n');
    });
    const openClaw = adapter(baseUrl);
    const items: Array<{ type: string }> = [];
    const consume = async () => {
      for await (const item of openClaw.streamReply({
        conversation,
        userMessage,
        history: [userMessage],
        targetAgentId: '[Letta] Lucy',
        selectedAgentId: '[Letta] Lucy',
        routingMode: 'direct',
        participants: [participant],
      })) items.push(item);
    };

    await expect(consume()).rejects.toThrow('OpenClaw Gateway error: approval continuation failed');
    expect(items).toEqual([]);
  });
});
