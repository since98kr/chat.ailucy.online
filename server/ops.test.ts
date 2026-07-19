import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './index.js';
import { registerOperationsRoutes } from './ops.js';
import { registerRuntimeSecurity } from './security.js';

const originalEnv = { ...process.env };
const apps: Array<ReturnType<typeof buildApp>> = [];
const directories: string[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('operations status', () => {
  it('is authenticated and reports the exact applied security and build identity without secrets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat-v2-ops-'));
    directories.push(directory);
    process.env.CHAT_BUILD_SHA = 'abc123';
    process.env.CHAT_BUILD_TIME = '2026-07-18T00:00:00Z';
    process.env.CHAT_VERSION = '0.5.0';
    process.env.CHAT_ENVIRONMENT = 'test';

    const app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    const security = registerRuntimeSecurity(app, {
      authMode: 'token',
      accessToken: 'private-secret',
      allowedEmails: new Set(),
      allowedServiceClientIds: new Set(),
      allowedOrigins: new Set(),
      rateWindowMs: 60_000,
      generalRateLimit: 300,
      chatRateLimit: 30,
      uploadRateLimit: 60,
    });
    registerOperationsRoutes(app, security);
    apps.push(app);

    const unauthorized = await app.inject({ method: 'GET', url: '/api/ops/status' });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/api/ops/status',
      headers: { authorization: 'Bearer private-secret' },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.build).toMatchObject({ sha: 'abc123', version: '0.5.0', environment: 'test' });
    expect(payload.auth).toMatchObject({
      mode: 'token',
      allowedServiceClientCount: 0,
      accessJwtVerificationConfigured: false,
    });
    expect(JSON.stringify(payload)).not.toContain('private-secret');
  });
});
