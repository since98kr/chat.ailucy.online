import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalClaudeBaseUrl = process.env.CLAUDE_BASE_URL;

describe('Claude routing availability', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    app = undefined;
    directory = undefined;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalClaudeBaseUrl === undefined) delete process.env.CLAUDE_BASE_URL;
    else process.env.CLAUDE_BASE_URL = originalClaudeBaseUrl;
  });

  it('does not advertise or create direct Claude conversations without a configured backend', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CLAUDE_BASE_URL;
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-claude-unconfigured-'));
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();

    const roster = await app.inject({ method: 'GET', url: '/api/agents?systemId=claude' });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().agents).toEqual([
      expect.objectContaining({
        id: '[Claude] 테이아',
        enabled: true,
        directChatEnabled: false,
      }),
    ]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'claude', agentId: '[Claude] 테이아', title: 'unconfigured Claude' },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ error: 'AGENT_UNAVAILABLE' });
  });

  it('reconciles persisted Claude routeability when the backend is removed between restarts', async () => {
    process.env.NODE_ENV = 'production';
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-claude-reconcile-'));
    const databasePath = join(directory, 'chat.sqlite');
    const artifactRoot = join(directory, 'artifacts');

    process.env.CLAUDE_BASE_URL = 'http://127.0.0.1:65534';
    app = buildApp({ databasePath, artifactRoot });
    await app.ready();

    const initiallyRouteable = await app.inject({ method: 'GET', url: '/api/agents?systemId=claude' });
    expect(initiallyRouteable.statusCode).toBe(200);
    expect(initiallyRouteable.json().agents).toEqual([
      expect.objectContaining({ id: '[Claude] 테이아', directChatEnabled: true }),
    ]);

    await app.close();
    app = undefined;
    delete process.env.CLAUDE_BASE_URL;

    app = buildApp({ databasePath, artifactRoot });
    await app.ready();

    const reconciled = await app.inject({ method: 'GET', url: '/api/agents?systemId=claude' });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().agents).toEqual([
      expect.objectContaining({ id: '[Claude] 테이아', directChatEnabled: false }),
    ]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'claude', agentId: '[Claude] 테이아', title: 'stale Claude route' },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ error: 'AGENT_UNAVAILABLE' });
  });
});
