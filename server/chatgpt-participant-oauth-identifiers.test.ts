import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ChatDatabase } from './database.js';
import { registerChatGptParticipantMcp } from './chatgpt-participant-mcp.js';

const trailingSlashAuth = {
  resourceUrl: 'https://chat.example.test/mcp/chatgpt-participant',
  issuer: 'https://identity.example.test/',
  audience: 'chat-ailucy-chatgpt-participant',
  jwksUrl: 'https://identity.example.test/.well-known/jwks.json',
  authorizationServer: 'https://identity.example.test/',
};

describe('ChatGPT participant OAuth identifiers', () => {
  it('publishes the configured authorization-server identifier without stripping its trailing slash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatgpt-participant-oauth-id-'));
    const db = new ChatDatabase(join(dir, 'chat.sqlite'));
    const app = Fastify();
    registerChatGptParticipantMcp(app, db, {
      enabled: true,
      auth: trailingSlashAuth,
      verifyAccessToken: async () => ({ subject: 'tei-chatgpt', scopes: new Set(['chat:read']) }),
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource/mcp/chatgpt-participant',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().authorization_servers).toEqual([trailingSlashAuth.authorizationServer]);
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not normalize the issuer identifier before jwt verification', () => {
    const source = readFileSync(new URL('./chatgpt-participant-mcp.ts', import.meta.url), 'utf8');
    const validateStart = source.indexOf('function validateAuthConfig');
    const scopeStart = source.indexOf('function scopeSet', validateStart);
    const validator = source.slice(validateStart, scopeStart);
    expect(validateStart).toBeGreaterThanOrEqual(0);
    expect(scopeStart).toBeGreaterThan(validateStart);
    expect(validator).toContain("requireHttpsUrl(config.issuer, 'CHATGPT_PARTICIPANT_AUTH_ISSUER')");
    expect(validator).toContain('return { ...config };');
    expect(validator).not.toContain("replace(/\\/$/, '')");
  });
});
