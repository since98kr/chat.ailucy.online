import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConversationRecord, MessageRecord } from '../../shared/contracts.js';
import { HttpAgentAdapter } from './http.js';

const timestamp = '2026-07-18T00:00:00.000Z';
const conversation: ConversationRecord = {
  id: 'conversation-1',
  systemId: 'hermes',
  agentId: '[Hermes] Lucy',
  title: 'Adapter test',
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
const userMessage: MessageRecord = {
  id: 'message-1',
  conversationId: conversation.id,
  role: 'user',
  authorId: 'tei',
  content: '연결 테스트',
  state: 'complete',
  parentMessageId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
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

describe('HttpAgentAdapter', () => {
  it('probes health and normalizes SSE/OpenAI-compatible streaming chunks', async () => {
    let receivedBody: Record<string, unknown> = {};
    let authorization = '';
    const baseUrl = await startServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }

      authorization = String(request.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"type":"status","status":"Hermes 연결 중"}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"안녕"}}]}\n\n');
        response.write('data: {"delta":"하세요"}\n\n');
        response.end('data: [DONE]\n\n');
      });
    });

    const adapter = new HttpAgentAdapter('hermes', {
      baseUrl,
      chatPath: '/chat',
      healthPath: '/health',
      apiKey: 'secret-test-key',
      agentId: '[Hermes] Lucy',
      timeoutMs: 2_000,
    });

    const health = await adapter.health();
    expect(health).toMatchObject({ ok: true, mode: 'http' });

    const items = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
    })) items.push(item);

    expect(items).toEqual([
      { type: 'status', status: 'Hermes 연결 중' },
      { type: 'delta', delta: '안녕' },
      { type: 'delta', delta: '하세요' },
    ]);
    expect(authorization).toBe('Bearer secret-test-key');
    expect(receivedBody).toMatchObject({
      stream: true,
      system_id: 'hermes',
      agent_id: '[Hermes] Lucy',
      conversation_id: conversation.id,
    });
    const receivedMessages = receivedBody['messages'] as Array<Record<string, unknown>>;
    expect(receivedMessages[0]).toMatchObject({
      role: 'user',
      content: '연결 테스트',
      author_id: 'tei',
    });
  });

  it('normalizes NDJSON and plain text lines without mixing backend memory', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"status":"Letta 기억 조회"}\n');
      response.write('{"content":"개인 기억은 "}\n');
      response.write('현재 Conversation과 분리됩니다.\n');
      response.end();
    });

    const adapter = new HttpAgentAdapter('letta', {
      baseUrl,
      chatPath: '/chat',
      healthPath: '/health',
      timeoutMs: 2_000,
    });
    const lettaConversation = { ...conversation, systemId: 'letta' as const, agentId: '[Letta] Lucy' };
    const items = [];
    for await (const item of adapter.streamReply({
      conversation: lettaConversation,
      userMessage: { ...userMessage, conversationId: lettaConversation.id },
      history: [{ ...userMessage, conversationId: lettaConversation.id }],
    })) items.push(item);

    expect(items).toEqual([
      { type: 'status', status: 'Letta 기억 조회' },
      { type: 'delta', delta: '개인 기억은 ' },
      { type: 'delta', delta: '현재 Conversation과 분리됩니다.' },
    ]);
  });
});
