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
  allowedOrigins: new Set<string>(),
  rateWindowMs: 60_000,
  generalRateLimit: 300,
  chatRateLimit: 30,
  uploadRateLimit: 60,
};

describe('runtime security', () => {
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

  it('accepts only the configured Cloudflare Access identity', async () => {
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
      url: '/api/conversations',
      headers: { 'cf-access-authenticated-user-email': 'Tei@Example.com' },
    });
    expect(allowed.statusCode).toBe(200);
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
