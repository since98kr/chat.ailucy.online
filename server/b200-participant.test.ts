import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';

process.env.NODE_ENV = 'test';

describe('B200 participant contract', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    app = undefined;
    directory = undefined;
    delete process.env.B200_BASE_URL;
    delete process.env.B200_PROTOCOL;
    delete process.env.B200_MODEL_MAP_JSON;
    delete process.env.B200_AGENT_ID;
  });

  async function boot() {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-b200-'));
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();
    return app;
  }

  it('keeps B200 visible but inert when B200_BASE_URL is unset', async () => {
    delete process.env.B200_BASE_URL;
    const instance = await boot();

    const roster = await instance.inject({ method: 'GET', url: '/api/agents?systemId=b200' });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().agents).toEqual([
      expect.objectContaining({
        id: '[B200] qwen3.8-27b',
        systemId: 'b200',
        enabled: true,
        directChatEnabled: false,
      }),
    ]);

    const create = await instance.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'b200', agentId: '[B200] qwen3.8-27b', title: 'B200 disabled' },
    });
    expect(create.statusCode).toBe(409);
    expect(create.json()).toMatchObject({ error: 'AGENT_UNAVAILABLE' });
  });

  it('enables B200 source routing when a base URL is explicitly configured', async () => {
    process.env.B200_BASE_URL = 'http://b200.test';
    process.env.B200_PROTOCOL = 'openai';
    process.env.B200_MODEL_MAP_JSON = '{"[B200] qwen3.8-27b":"qwen3.8-27b"}';
    const instance = await boot();

    const roster = await instance.inject({ method: 'GET', url: '/api/agents?systemId=b200' });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().agents[0]).toMatchObject({
      id: '[B200] qwen3.8-27b',
      directChatEnabled: true,
      isLead: true,
    });

    const create = await instance.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'b200', agentId: '[B200] qwen3.8-27b', title: 'B200 source-ready' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().conversation).toMatchObject({
      systemId: 'b200',
      agentId: '[B200] qwen3.8-27b',
    });
  });

  it('boots an existing canonical three-system database and admits B200 without losing state', async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-b200-migrate-'));
    const databasePath = join(directory, 'chat.sqlite');
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        system_id TEXT NOT NULL CHECK (system_id IN ('openclaw', 'hermes', 'claude')),
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'trashed')),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_read_message_id TEXT,
        draft TEXT NOT NULL DEFAULT '',
        branched_from_conversation_id TEXT,
        branched_from_message_id TEXT
      );
      INSERT INTO conversations VALUES (
        'existing', 'openclaw', '[OpenClaw] Lucy', 'Existing', 'keep-me', 'active', 1,
        '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z', NULL, '', NULL, NULL
      );
    `);
    db.close();

    process.env.B200_BASE_URL = 'http://b200.test';
    app = buildApp({ databasePath, artifactRoot: join(directory, 'artifacts') });
    await app.ready();

    const existing = await app.inject({ method: 'GET', url: '/api/conversations/existing' });
    expect(existing.statusCode).toBe(200);
    expect(existing.json().conversation).toMatchObject({ preview: 'keep-me', systemId: 'openclaw' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'b200', agentId: '[B200] qwen3.8-27b' },
    });
    expect(created.statusCode).toBe(201);
  });
});
