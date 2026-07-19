import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './index.js';
import { clearSecurityRateState, registerRuntimeSecurity } from './security.js';

const apps: Array<ReturnType<typeof buildApp>> = [];
const directories: string[] = [];

function createApp(config: Parameters<typeof registerRuntimeSecurity>[1]) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-v2-security-'));
  directories.push(directory);
  const app = buildApp({
    databasePath: join(directory, 'chat.sqlite'),
    artifactRoot: join(directory, 'artifacts'),
  });
  registerRuntimeSecurity(app, config);
  apps.push(app);
  return app;
}

beforeEach(() => clearSecurityRateState());

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const defaults = {
  allowedEmails: new Set<string>(),
  allowedServiceClientIds: new Set<string>(),
  allowedOrigins: new Set<string>(),
  rateWindowMs: 60_000,
  generalRateLimit: 300,
  chatRateLimit: 30,
  uploadRateLimit: 60,
};

describe('runtime security', () => {
  it('publishes only the authentication mode before authentication', async () => {
    const app = createApp({ ...defaults, authMode: 'token', accessToken: 'correct-secret' });
    const response = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode: 'token' });
    expect(response.body).not.toContain('correct-secret');
  });

  it('exchanges a valid token for an HttpOnly browser session cookie', async () => {
    const app = createApp({ ...defaults, authMode: 'token', accessToken: 'correct-secret' });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'wrong-secret' },
    });
    expect(invalid.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'correct-secret' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('chat_v2_session=correct-secret');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, mode: 'token' });

    const conversations = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(conversations.statusCode).toBe(200);

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('keeps health public but requires a valid bearer token for private API routes', async () => {
    const app = createApp({ ...defaults, authMode: 'token', accessToken: 'correct-secret' });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-content-type-options']).toBe('nosniff');

    const unauthorized = await app.inject({ method: 'GET', url: '/api/conversations' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ error: 'AUTHENTICATION_REQUIRED' });

    const authorized = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: 'Bearer correct-secret' },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it('accepts only the configured Cloudflare Access email identity', async () => {
    const app = createApp({
      ...defaults,
      authMode: 'cloudflare',
      allowedEmails: new Set(['tei@example.com']),
    });

    const denied = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { 'cf-access-authenticated-user-email': 'someone@example.com' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { 'cf-access-authenticated-user-email': 'Tei@Example.com' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ identity: 'tei@example.com', mode: 'cloudflare' });
  });

  it('accepts a verified and allowlisted Cloudflare service token identity', async () => {
    const app = createApp({
      ...defaults,
      authMode: 'cloudflare',
      allowedServiceClientIds: new Set(['qa-client.access']),
      cloudflareAccessVerifier: async (assertion) => {
        if (assertion !== 'signed-service-assertion') throw new Error('invalid assertion');
        return { kind: 'service', value: 'QA-CLIENT.ACCESS' };
      },
    });

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { 'cf-access-jwt-assertion': 'signed-service-assertion' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      identity: 'service:qa-client.access',
      mode: 'cloudflare',
    });
  });

  it('rejects invalid or non-allowlisted Cloudflare service identities', async () => {
    const app = createApp({
      ...defaults,
      authMode: 'cloudflare',
      allowedServiceClientIds: new Set(['qa-client.access']),
      cloudflareAccessVerifier: async (assertion) => {
        if (assertion === 'bad-signature') throw new Error('signature verification failed');
        return { kind: 'service', value: 'different-client.access' };
      },
    });

    const wrongClient = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { 'cf-access-jwt-assertion': 'valid-but-wrong-client' },
    });
    expect(wrongClient.statusCode).toBe(403);
    expect(wrongClient.json()).toEqual({ error: 'ACCESS_DENIED' });

    const badSignature = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { 'cf-access-jwt-assertion': 'bad-signature' },
    });
    expect(badSignature.statusCode).toBe(403);
    expect(badSignature.json()).toEqual({ error: 'ACCESS_DENIED' });
  });

  it('rejects cross-origin mutations and rate limits repeated private requests', async () => {
    const app = createApp({
      ...defaults,
      authMode: 'disabled',
      allowedOrigins: new Set(['https://chat.ailucy.online']),
      generalRateLimit: 1,
    });

    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { origin: 'https://evil.example' },
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toEqual({ error: 'ORIGIN_NOT_ALLOWED' });

    const first = await app.inject({ method: 'GET', url: '/api/conversations' });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'GET', url: '/api/conversations' });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
  });
});
