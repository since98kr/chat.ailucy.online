import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerChatGptParticipantMcp } from './chatgpt-participant-mcp.js';
import { ChatDatabase } from './database.js';

const cleanup: string[] = [];

const auth = {
  resourceUrl: 'https://chat.example.test/mcp/chatgpt-participant',
  issuer: 'https://identity.example.test/',
  audience: 'chat-ailucy-chatgpt-participant',
  jwksUrl: 'https://identity.example.test/.well-known/jwks.json',
  authorizationServer: 'https://identity.example.test/',
};

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chatgpt-participant-compat-'));
  cleanup.push(dir);
  const db = new ChatDatabase(join(dir, 'chat.sqlite'));
  const room = db.createConversation('hermes', '[Hermes] Lucy', 'Compatibility test');
  const app = Fastify();
  registerChatGptParticipantMcp(app, db, {
    enabled: true,
    auth,
    verifyAccessToken: async () => ({ subject: 'tei-chatgpt', scopes: new Set(['chat:read', 'chat:write']) }),
  });
  await app.ready();
  return { app, db, room };
}

async function closeFixture(value: Awaited<ReturnType<typeof fixture>>) {
  await value.app.close();
  value.db.close();
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('ChatGPT participant MCP compatibility', () => {
  it('advertises a structured error variant and preserves the OAuth challenge', async () => {
    const value = await fixture();

    const listed = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: { 'mcp-protocol-version': '2025-06-18' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(listed.statusCode).toBe(200);
    const tools = listed.json().result.tools as Array<{ outputSchema: { oneOf?: unknown[] } }>;
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.outputSchema.oneOf).toHaveLength(2);
      expect(tool.outputSchema.oneOf?.[1]).toMatchObject({
        type: 'object',
        required: ['error', 'message'],
        additionalProperties: false,
      });
    }

    const missingAuth = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: { 'mcp-protocol-version': '2025-06-18' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_chat_room', arguments: { conversationId: value.room.id } },
      },
    });
    expect(missingAuth.statusCode).toBe(200);
    expect(missingAuth.json().result).toMatchObject({
      isError: true,
      structuredContent: {
        error: 'OAUTH_ACCESS_TOKEN_REQUIRED',
        message: expect.any(String),
      },
    });
    expect(Object.keys(missingAuth.json().result.structuredContent).sort()).toEqual(['error', 'message']);
    expect(missingAuth.json().result._meta['mcp/www_authenticate'][0]).toContain('resource_metadata=');

    await closeFixture(value);
  });

  it('negotiates initialization to the supported version and rejects an unsupported later header', async () => {
    const value = await fixture();

    const initialize = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: { 'mcp-protocol-version': '2025-11-25' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      },
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json().result.protocolVersion).toBe('2025-06-18');

    const unsupported = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: { 'mcp-protocol-version': '2025-11-25' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32600, message: 'Unsupported MCP-Protocol-Version: 2025-11-25' },
    });

    const supported = await value.app.inject({
      method: 'POST',
      url: '/mcp/chatgpt-participant',
      headers: { 'mcp-protocol-version': '2025-06-18' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    });
    expect(supported.statusCode).toBe(200);

    await closeFixture(value);
  });
});
