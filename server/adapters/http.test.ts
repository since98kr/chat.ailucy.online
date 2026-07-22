import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactRecord,
  ConversationParticipantRecord,
  ConversationRecord,
  MessageRecord,
} from '../../shared/contracts.js';
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
const participants: ConversationParticipantRecord[] = [{
  conversationId: conversation.id,
  agentId: '[Hermes] Lucy',
  role: 'lead',
  state: 'active',
  addedAt: timestamp,
  updatedAt: timestamp,
  agent: {
    id: '[Hermes] Lucy',
    systemId: 'hermes',
    displayName: '[Hermes] Lucy',
    shortName: 'Lucy',
    role: 'Lead Orchestrator',
    description: '',
    capabilities: ['orchestration'],
    enabled: true,
    directChatEnabled: true,
    isLead: true,
    sortOrder: 10,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
}];

let server: Server | null = null;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = null;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startServer(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function artifactFixture(filename: string, mimeType: string, bytes: Buffer): Promise<ArtifactRecord> {
  const directory = await mkdtemp(join(tmpdir(), 'chat-v2-http-artifact-'));
  temporaryDirectories.push(directory);
  const storagePath = join(directory, filename);
  await writeFile(storagePath, bytes);
  return {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    messageId: userMessage.id,
    filename,
    mimeType,
    sizeBytes: bytes.length,
    storagePath,
    createdAt: timestamp,
  };
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
      targetAgentId: 'Xixi',
      routingMode: 'team',
      participants,
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
      agent_id: 'Xixi',
      configured_agent_id: '[Hermes] Lucy',
      conversation_id: conversation.id,
      metadata: {
        routing_mode: 'team',
        target_agent_id: 'Xixi',
        artifact_count: 0,
      },
    });
    const receivedMessages = receivedBody['messages'] as Array<Record<string, unknown>>;
    expect(receivedMessages[0]).toMatchObject({
      role: 'user',
      content: '연결 테스트',
      author_id: 'tei',
    });
    const receivedParticipants = receivedBody['participants'] as Array<Record<string, unknown>>;
    expect(receivedParticipants[0]).toMatchObject({ agent_id: '[Hermes] Lucy', role: 'lead' });
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
    const lettaParticipant = {
      ...participants[0],
      conversationId: lettaConversation.id,
      agentId: '[Letta] Lucy',
      agent: {
        ...participants[0].agent,
        id: '[Letta] Lucy',
        systemId: 'letta' as const,
        displayName: '[Letta] Lucy',
      },
    };
    const items = [];
    for await (const item of adapter.streamReply({
      conversation: lettaConversation,
      userMessage: { ...userMessage, conversationId: lettaConversation.id },
      history: [{ ...userMessage, conversationId: lettaConversation.id }],
      targetAgentId: '[Letta] Lucy',
      routingMode: 'direct',
      participants: [lettaParticipant],
    })) items.push(item);

    expect(items).toEqual([
      { type: 'status', status: 'Letta 기억 조회' },
      { type: 'delta', delta: '개인 기억은 ' },
      { type: 'delta', delta: '현재 Conversation과 분리됩니다.' },
    ]);
  });

  it('sends bounded native artifact bytes and accepts generated artifact events', async () => {
    const noteBytes = Buffer.from('ATTACHMENT_MARKER_2026\n한글 문서', 'utf8');
    const note = await artifactFixture('input-note.txt', 'text/plain', noteBytes);
    let receivedBody: Record<string, unknown> = {};
    const baseUrl = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write(`${JSON.stringify({
          type: 'artifact.created',
          artifact: {
            filename: 'generated-note.txt',
            mime_type: 'text/plain',
            content_text: 'GENERATED_ARTIFACT_MARKER',
          },
        })}\n`);
        response.end('{"delta":"완료"}\n');
      });
    });

    const adapter = new HttpAgentAdapter('hermes', {
      baseUrl,
      chatPath: '/chat',
      healthPath: '/health',
      timeoutMs: 2_000,
    });
    const items = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
      artifacts: [note],
      targetAgentId: '[Hermes] Lucy',
      routingMode: 'direct',
      participants,
    })) items.push(item);

    const receivedArtifacts = receivedBody['artifacts'] as Array<Record<string, unknown>>;
    expect(receivedArtifacts).toHaveLength(1);
    expect(receivedArtifacts[0]).toMatchObject({
      artifact_id: note.id,
      filename: note.filename,
      mime_type: 'text/plain',
      size_bytes: noteBytes.length,
      text: noteBytes.toString('utf8'),
    });
    expect(Buffer.from(String(receivedArtifacts[0].content_base64), 'base64')).toEqual(noteBytes);
    expect(items).toEqual([
      {
        type: 'artifact',
        artifact: {
          filename: 'generated-note.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('GENERATED_ARTIFACT_MARKER', 'utf8').toString('base64'),
        },
      },
      { type: 'delta', delta: '완료' },
    ]);
  });

  it('builds OpenAI-compatible text and image content parts', async () => {
    const note = await artifactFixture('context.md', 'text/markdown', Buffer.from('DOC_ONLY_MARKER', 'utf8'));
    const imageBytes = Buffer.from('fake-png-bytes');
    const image = await artifactFixture('photo.png', 'image/png', imageBytes);
    let receivedBody: Record<string, unknown> = {};
    const baseUrl = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"choices":[{"message":{"content":"OPENAI_OK"}}]}');
      });
    });

    const adapter = new HttpAgentAdapter('hermes', {
      baseUrl,
      chatPath: '/chat',
      healthPath: '/health',
      timeoutMs: 2_000,
      protocol: 'openai',
      modelMap: { '[Hermes] Lucy': 'vision-model' },
    });
    const items = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
      artifacts: [note, image],
      targetAgentId: '[Hermes] Lucy',
      routingMode: 'direct',
      participants,
    })) items.push(item);

    expect(receivedBody.model).toBe('vision-model');
    const messages = receivedBody.messages as Array<{ role: string; content: string | OpenAiTestPart[] }>;
    const content = messages.at(-1)?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as OpenAiTestPart[];
    expect(parts[0].text).toContain('DOC_ONLY_MARKER');
    expect(parts[1].image_url?.url).toBe(`data:image/png;base64,${imageBytes.toString('base64')}`);
    expect(items).toEqual([{ type: 'delta', delta: 'OPENAI_OK' }]);
  });
});

type OpenAiTestPart = {
  type: string;
  text?: string;
  image_url?: { url: string };
};
