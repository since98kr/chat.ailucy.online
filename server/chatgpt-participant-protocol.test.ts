import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ChatDatabase } from './database.js';
import { registerChatGptParticipantMcp } from './chatgpt-participant-mcp.js';

const auth = {
  resourceUrl: 'https://chat.example.test/mcp/chatgpt-participant',
  issuer: 'https://identity.example.test',
  audience: 'chat-ailucy-chatgpt-participant',
  jwksUrl: 'https://identity.example.test/.well-known/jwks.json',
  authorizationServer: 'https://identity.example.test',
};

describe('ChatGPT participant MCP protocol negotiation', () => {
  it('returns the server-supported protocol when the client requests another revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatgpt-participant-protocol-'));
    const db = new ChatDatabase(join(dir, 'chat.sqlite'));
    const app = Fastify();
    registerChatGptParticipantMcp(app, db, {
      enabled: true,
      auth,
      verifyAccessToken: async () => ({ subject: 'tei-chatgpt', scopes: new Set(['chat:read']) }),
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/mcp/chatgpt-participant',
        headers: { accept: 'application/json, text/event-stream' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'compat-test', version: '1' },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result.protocolVersion).toBe('2025-06-18');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
