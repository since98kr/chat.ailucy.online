import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ConversationParticipantRecord,
  ConversationRecord,
  MessageRecord,
} from '../../shared/contracts.js';
import { HttpAgentAdapter } from './http.js';
import { OpenClawLettaAdapter } from './openclaw-letta.js';

const timestamp = '2026-09-12T00:00:00.000Z';
let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  server = null;
});

async function startServer(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fixture(systemId: 'letta', agentId: string) {
  const conversation: ConversationRecord = {
    id: 'conversation-receipt',
    systemId,
    agentId,
    title: 'Receipt transport test',
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
    id: 'message-receipt',
    conversationId: conversation.id,
    role: 'user',
    authorId: 'tei',
    content: '실행해',
    state: 'complete',
    parentMessageId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const participant: ConversationParticipantRecord = {
    conversationId: conversation.id,
    agentId,
    role: 'lead',
    state: 'active',
    addedAt: timestamp,
    updatedAt: timestamp,
    agent: {
      id: agentId,
      systemId,
      displayName: agentId,
      shortName: 'Lucy',
      role: 'Primary Cognitive Agent',
      description: '',
      capabilities: ['planning', 'orchestration'],
      enabled: true,
      directChatEnabled: true,
      isLead: true,
      sortOrder: 10,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
  return { conversation, userMessage, participant };
}

describe('provider execution receipt transport', () => {
  it('carries encoded correlation headers and restores an echoed receipt through HttpAgentAdapter', async () => {
    const seen: Record<string, string> = {};
    const baseUrl = await startServer((request, response) => {
      seen.session = String(request.headers['x-lucy-execution-session-id'] ?? '');
      seen.operation = String(request.headers['x-lucy-execution-operation-id'] ?? '');
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({
          type: 'execution-evidence',
          evidence: {
            kind: 'result-receipt',
            sessionId: seen.session,
            operationId: seen.operation,
            receiptId: 'http-result-1',
          },
        })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    const { conversation, userMessage, participant } = fixture('letta', '[OpenClaw] Lucy');
    const adapter = new HttpAgentAdapter('letta', {
      baseUrl,
      chatPath: '/chat',
      healthPath: '/health',
      agentId: '[OpenClaw] Lucy',
      timeoutMs: 2_000,
      protocol: 'native',
    });

    const items = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
      targetAgentId: '[OpenClaw] Lucy',
      selectedAgentId: '[OpenClaw] Lucy',
      routingMode: 'direct',
      participants: [participant],
      sessionId: 'session-http-테이아',
      idempotencyKey: 'operation-http-실행',
    })) items.push(item);

    expect(seen.session).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(seen.operation).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(seen.session).not.toContain('테이아');
    expect(seen.operation).not.toContain('실행');
    expect(items).toEqual([{
      type: 'execution-evidence',
      evidence: {
        kind: 'result-receipt',
        sessionId: 'session-http-테이아',
        operationId: 'operation-http-실행',
        receiptId: 'http-result-1',
      },
    }]);
  });

  it('carries encoded correlation headers and restores an echoed receipt through OpenClawLettaAdapter', async () => {
    const seen: Record<string, string> = {};
    const baseUrl = await startServer((request, response) => {
      seen.session = String(request.headers['x-lucy-execution-session-id'] ?? '');
      seen.operation = String(request.headers['x-lucy-execution-operation-id'] ?? '');
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({
          type: 'execution-evidence',
          evidence: {
            kind: 'tool-receipt',
            session_id: seen.session,
            operation_id: seen.operation,
            receipt_id: 'openclaw-tool-1',
          },
        })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    const { conversation, userMessage, participant } = fixture('letta', '[OpenClaw] Lucy');
    const adapter = new OpenClawLettaAdapter({
      baseUrl,
      chatPath: '/v1/chat/completions',
      healthPath: '/health',
      apiKey: 'gateway-test-key',
      agentTarget: 'openclaw/main',
      sessionPrefix: 'chat-v2',
      timeoutMs: 2_000,
      maxArtifactBytes: 10 * 1024 * 1024,
      maxArtifactTotalBytes: 20 * 1024 * 1024,
      artifactToolEnabled: false,
    });

    const items = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
      targetAgentId: '[OpenClaw] Lucy',
      selectedAgentId: '[OpenClaw] Lucy',
      routingMode: 'direct',
      participants: [participant],
      sessionId: 'session-openclaw-루시',
      idempotencyKey: 'operation-openclaw-도구',
    })) items.push(item);

    expect(seen.session).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(seen.operation).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(seen.session).not.toContain('루시');
    expect(seen.operation).not.toContain('도구');
    expect(items).toEqual([{
      type: 'execution-evidence',
      evidence: {
        kind: 'tool-receipt',
        sessionId: 'session-openclaw-루시',
        operationId: 'operation-openclaw-도구',
        receiptId: 'openclaw-tool-1',
      },
    }]);
  });
});
