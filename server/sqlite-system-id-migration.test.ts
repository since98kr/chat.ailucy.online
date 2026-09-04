// Current-main revalidation marker: Claude SystemId migration remains covered after syncing #206.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';
import { widenSystemIdCheckConstraints } from './sqlite-system-id-migration.js';

process.env.NODE_ENV = 'test';
delete process.env.LETTA_BASE_URL;
delete process.env.HERMES_BASE_URL;
delete process.env.CLAUDE_BASE_URL;
delete process.env.B200_BASE_URL;

describe('Claude SystemId schema migration', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    app = undefined;
    directory = undefined;
    delete process.env.CLAUDE_BASE_URL;
  });

  it('widens every legacy SystemId CHECK in a table and preserves rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE capsules (
        id TEXT PRIMARY KEY,
        source_system_id TEXT NOT NULL CHECK (source_system_id IN ('letta', 'hermes')),
        target_system_id TEXT NOT NULL CHECK (target_system_id IN ('letta', 'hermes'))
      );
      INSERT INTO capsules VALUES ('legacy', 'letta', 'hermes');
    `);
    expect(widenSystemIdCheckConstraints(db, 'capsules')).toBe(true);
    expect(db.prepare('SELECT * FROM capsules WHERE id = ?').get('legacy')).toMatchObject({
      source_system_id: 'letta',
      target_system_id: 'hermes',
    });
    expect(() => db.prepare('INSERT INTO capsules VALUES (?, ?, ?)').run('new', 'claude', 'hermes')).not.toThrow();
    expect(widenSystemIdCheckConstraints(db, 'capsules')).toBe(false);
    db.close();
  });

  it('boots an existing pre-Claude database and enables Theia without losing existing state', async () => {
    process.env.CLAUDE_BASE_URL = 'http://claude.test';
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-claude-migrate-'));
    const databasePath = join(directory, 'chat.sqlite');
    const legacy = new Database(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        system_id TEXT NOT NULL CHECK (system_id IN ('letta', 'hermes')),
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
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        system_id TEXT NOT NULL CHECK (system_id IN ('letta', 'hermes')),
        display_name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        role TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        direct_chat_enabled INTEGER NOT NULL DEFAULT 0 CHECK (direct_chat_enabled IN (0, 1)),
        is_lead INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 100,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conversation_federation (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'federated' CHECK (mode IN ('single', 'federated')),
        coordinator_agent_id TEXT NOT NULL,
        allowed_system_ids_json TEXT NOT NULL DEFAULT '["letta","hermes"]',
        memory_policy TEXT NOT NULL DEFAULT 'explicit-capsules-only' CHECK (memory_policy = 'explicit-capsules-only'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_capsules (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_system_id TEXT NOT NULL CHECK (source_system_id IN ('letta', 'hermes')),
        target_system_id TEXT NOT NULL CHECK (target_system_id IN ('letta', 'hermes')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'revoked')),
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO conversations VALUES (
        'legacy-chat', 'hermes', '[Hermes] Lucy', '기존 대화', '보존되어야 함', 'active', 1,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL, '', NULL, NULL
      );
      INSERT INTO conversation_federation VALUES (
        'legacy-chat', 'federated', '[Hermes] Lucy', '["letta","hermes"]',
        'explicit-capsules-only', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    app = buildApp({ databasePath, artifactRoot: join(directory, 'artifacts') });
    await app.ready();

    const roster = await app.inject({ method: 'GET', url: '/api/agents?systemId=claude' });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '[Claude] 테이아', systemId: 'claude', enabled: true }),
    ]));

    const existing = await app.inject({ method: 'GET', url: '/api/conversations/legacy-chat' });
    expect(existing.statusCode).toBe(200);
    expect(existing.json().conversation).toMatchObject({ id: 'legacy-chat', preview: '보존되어야 함' });

    const config = await app.inject({ method: 'GET', url: '/api/conversations/legacy-chat/federation' });
    expect(config.json().federation.config.allowedSystemIds).toEqual(['letta', 'hermes', 'claude', 'b200']);

    const capsule = await app.inject({
      method: 'POST',
      url: '/api/conversations/legacy-chat/memory-capsules',
      payload: { sourceSystemId: 'claude', targetSystemId: 'hermes', title: '테이아 검토', content: '독립 검토 결과' },
    });
    expect(capsule.statusCode).toBe(201);

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'claude', agentId: '[Claude] 테이아', title: '테이아 직접 대화' },
    });
    expect(created.statusCode).toBe(201);
  });
});
