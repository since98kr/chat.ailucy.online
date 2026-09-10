import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatDatabase } from './database.js';
import {
  registerChatGptParticipantMcp,
  type ChatGptParticipantIdentity,
} from './chatgpt-participant-mcp.js';

const cleanup: string[] = [];
const auth = {
  resourceUrl: 'https://chat.example.test/mcp/chatgpt-participant',
  issuer: 'https://identity.example.test',
  audience: 'chat-ailucy-chatgpt-participant',
  jwksUrl: 'https://identity.example.test/.well-known/jwks.json',
  authorizationServer: 'https://identity.example.test',
};

function identity(scopes: string[]): ChatGptParticipantIdentity {
  return { subject: 'tei-chatgpt', scopes: new Set(scopes) };
}

async function fixture(options?: { enabled?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'chatgpt-participant-mcp-'));
  cleanup.push(dir);
  const db = new ChatDatabase(join(dir, 'chat.sqlite'));
  const room = db.createConversation('hermes', '[Hermes] Lucy', 'ChatGPT participant test');
  const otherRoom = db.createConversation('hermes', 'Xixi', 'Other room');
  const first = db.addMessage({
    conversationId: room.id,
    role: 'user',
    authorId: 'tei',
    content: '첫 메시지',
  });
  const second = db.addMessage({
    conversationId: room.id,
    role: 'assistant',
    authorId: '[Hermes] Lucy',
    content: '두 번째 메시지',
    parentMessageId: first.id,
  });
  const foreign = db.addMessage({
    conversationId: otherRoom.id,
    role: 'assistant',
    authorId: 'Xixi',
    content: '다른 방 메시지',
  });

  const app = Fastify();
  registerChatGptParticipantMcp(app, db, {
    enabled: options?.enabled ?? true,
    auth,
    verifyAccessToken: async (token) => {
      if (token === 'read') return identity(['chat:read']);
      if (token === 'write') return identity(['chat:write']);
      if (token === 'full') return identity(['chat:read', 'chat:write']);
      throw new Error('invalid token');
    },
  });
  await app.ready();
  return { app, db, room, otherRoom, first, second, foreign };
}

function headers(token = 'full') {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
}

async function callTool(
  app: Awaited<ReturnType<typeof fixture>>['app'],
  name: string,
  args: Record<string, unknown>,
  token = 'full',
  id = 10,
) {
  return app.inject({
    method: 'POST',
    url: '/mcp/chatgpt-participant',
    headers: headers(token),
    payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
}

async function closeFixture(value: Awaited<ReturnType<typeof fixture>>) {
  await value.app.close();
  value.db.close();
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('ChatGPT Lucy participant MCP', () => {
  it('is absent unless explicitly enabled', async () => {
    const value = await fixture({ enabled: false });
    const response = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(response.statusCode).toBe(404);
    await closeFixture(value);
  });

  it('publishes protected-resource metadata and fails closed without a valid OAuth bearer', async () => {
    const value = await fixture();
    const metadata = await value.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp/chatgpt-participant',
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      resource: auth.resourceUrl,
      authorization_servers: [auth.authorizationServer],
      scopes_supported: ['chat:read', 'chat:write'],
    });

    const missing = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toContain('oauth-protected-resource/mcp/chatgpt-participant');

    const invalid = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: headers('invalid'),
      payload: { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    });
    expect(invalid.statusCode).toBe(401);
    await closeFixture(value);
  });

  it('implements stateless MCP lifecycle with correctly annotated read/write tools', async () => {
    const value = await fixture();
    const initialize = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: headers(),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT', version: 'test' } },
      },
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json().result.protocolVersion).toBe('2025-06-18');
    expect(initialize.json().result.serverInfo.name).toBe('chat-ailucy-chatgpt-participant');

    const initialized = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: headers(),
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(initialized.statusCode).toBe(202);

    const listed = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: headers(),
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    const tools = listed.json().result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_chat_rooms',
      'read_chat_room',
      'post_chatgpt_lucy_message',
    ]);
    expect(tools[0].annotations.readOnlyHint).toBe(true);
    expect(tools[0].securitySchemes[0].scopes).toEqual(['chat:read']);
    expect(tools[2].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools[2].securitySchemes[0].scopes).toEqual(['chat:write']);

    const get = await value.app.inject({
      method: 'GET',
      url: '/mcp/chatgpt-participant',
      headers: headers(),
    });
    expect(get.statusCode).toBe(405);
    await closeFixture(value);
  });

  it('lists and incrementally reads canonical room messages without exposing artifact storage paths', async () => {
    const value = await fixture();
    value.db.addArtifact({
      conversationId: value.room.id,
      messageId: value.second.id,
      filename: 'private.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      storagePath: '/secret/storage/private.txt',
    });

    const rooms = await callTool(value.app, 'list_chat_rooms', { status: 'active', limit: 20 }, 'read');
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json().result.structuredContent.rooms.some((room: { id: string }) => room.id === value.room.id)).toBe(true);

    const read = await callTool(value.app, 'read_chat_room', {
      conversationId: value.room.id,
      afterMessageId: value.first.id,
      limit: 20,
    }, 'read');
    const body = read.json().result.structuredContent;
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual([value.second.id]);
    expect(body.messages[0]).toMatchObject({ authorId: '[Hermes] Lucy', content: '두 번째 메시지' });
    expect(JSON.stringify(body)).not.toContain('storagePath');
    expect(JSON.stringify(body)).not.toContain('/secret/storage/private.txt');

    const foreignCursor = await callTool(value.app, 'read_chat_room', {
      conversationId: value.room.id,
      afterMessageId: value.foreign.id,
    }, 'read');
    expect(foreignCursor.json().result).toMatchObject({
      isError: true,
      structuredContent: { error: 'AFTER_MESSAGE_NOT_IN_CONVERSATION' },
    });
    await closeFixture(value);
  });

  it('posts only as [ChatGPT] Lucy, validates parent ownership, scopes writes, and deduplicates retries', async () => {
    const value = await fixture();
    const denied = await callTool(value.app, 'post_chatgpt_lucy_message', {
      conversationId: value.room.id,
      content: '읽기 토큰으로는 쓰면 안 됩니다.',
      idempotencyKey: 'scope-test-001',
    }, 'read');
    expect(denied.json().result).toMatchObject({
      isError: true,
      structuredContent: { error: 'INSUFFICIENT_SCOPE' },
    });
    expect(denied.json().result._meta['mcp/www_authenticate'][0]).toContain('chat:write');

    const foreignParent = await callTool(value.app, 'post_chatgpt_lucy_message', {
      conversationId: value.room.id,
      content: '잘못된 parent',
      parentMessageId: value.foreign.id,
      idempotencyKey: 'parent-test-001',
    }, 'write');
    expect(foreignParent.json().result.structuredContent.error).toBe('PARENT_MESSAGE_NOT_IN_CONVERSATION');

    const args = {
      conversationId: value.room.id,
      content: 'Hermes Lucy의 답을 읽었습니다. 저는 이렇게 봅니다.',
      parentMessageId: value.second.id,
      idempotencyKey: 'chatgpt-lucy-post-001',
    };
    const firstPost = await callTool(value.app, 'post_chatgpt_lucy_message', args, 'write');
    expect(firstPost.json().result).toMatchObject({
      isError: false,
      structuredContent: {
        participant: '[ChatGPT] Lucy',
        created: true,
        message: {
          role: 'assistant',
          authorId: '[ChatGPT] Lucy',
          content: args.content,
          parentMessageId: value.second.id,
        },
      },
    });
    const postedId = firstPost.json().result.structuredContent.message.id;

    const retry = await callTool(value.app, 'post_chatgpt_lucy_message', args, 'write');
    expect(retry.json().result.structuredContent.created).toBe(false);
    expect(retry.json().result.structuredContent.message.id).toBe(postedId);
    const chatGptMessages = value.db.getConversation(value.room.id)!.messages
      .filter((message) => message.authorId === '[ChatGPT] Lucy');
    expect(chatGptMessages).toHaveLength(1);

    const conflict = await callTool(value.app, 'post_chatgpt_lucy_message', {
      ...args,
      content: '같은 키로 다른 내용을 쓰면 안 됩니다.',
    }, 'write');
    expect(conflict.json().result.structuredContent.error).toBe('IDEMPOTENCY_CONFLICT');
    expect(value.db.getConversation(value.room.id)!.messages
      .filter((message) => message.authorId === '[ChatGPT] Lucy')).toHaveLength(1);
    await closeFixture(value);
  });
});
