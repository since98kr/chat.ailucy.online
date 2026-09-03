import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';

process.env.NODE_ENV = 'test';

describe('federation conversation identity guard', () => {
  let directory: string;
  let databasePath: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-federation-identity-'));
    databasePath = join(directory, 'chat.sqlite');
    app = buildApp({
      databasePath,
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createConversation = async (systemId: 'letta' | 'hermes', agentId: string, title: string) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId, agentId, title },
    });
    expect(created.statusCode).toBe(201);
    return created.json().conversation.id as string;
  };

  const seedStaleFederation = (conversationId: string) => {
    const db = new Database(databasePath);
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversation_federation (
        conversation_id, mode, coordinator_agent_id, allowed_system_ids_json,
        memory_policy, created_at, updated_at
      ) VALUES (?, 'federated', '[Hermes] Lucy', ?, 'explicit-capsules-only', ?, ?)
    `).run(conversationId, JSON.stringify(['letta', 'hermes', 'claude']), timestamp, timestamp);
    db.close();
  };

  it('rejects federation on a personal Letta conversation', async () => {
    const id = await createConversation('letta', '[Letta] Lucy', 'Personal Lucy');
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/federation`,
      payload: { coordinatorAgentId: '[Hermes] Lucy' },
    });
    expect(enabled.statusCode).toBe(409);
    expect(enabled.json()).toMatchObject({
      error: 'FEDERATED_CONVERSATION_REQUIRES_HERMES_LUCY',
    });
  });

  it('keeps a persisted stale Letta federation config inert after upgrade', async () => {
    const id = await createConversation('letta', '[Letta] Lucy', 'Persisted personal Lucy');
    seedStaleFederation(id);

    const snapshot = await app.inject({ method: 'GET', url: `/api/conversations/${id}/federation` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().federation.config).toBeNull();

    const direct = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: {
        content: 'ordinary personal chat remains direct',
        workflowMode: 'chat',
        idempotencyKey: 'stale-personal-direct-0001',
      },
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.body).not.toContain('"type":"workflow.run"');

    const federated = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: {
        content: 'do not federate this personal conversation',
        workflowMode: 'federated',
        idempotencyKey: 'stale-personal-federated-0001',
      },
    });
    expect(federated.statusCode).toBe(409);
    expect(federated.json()).toMatchObject({
      error: 'FEDERATED_CONVERSATION_REQUIRES_HERMES_LUCY',
    });

    const capsule = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/memory-capsules`,
      payload: {
        sourceSystemId: 'letta',
        targetSystemId: 'hermes',
        title: 'must stay inert',
        content: 'stale cross-system state',
      },
    });
    expect(capsule.statusCode).toBe(409);
    expect(capsule.json()).toMatchObject({
      error: 'FEDERATED_CONVERSATION_REQUIRES_HERMES_LUCY',
    });
  });

  it('still allows federation on an explicit Hermes Lucy conversation', async () => {
    const id = await createConversation('hermes', '[Hermes] Lucy', 'Hermes federation');
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/federation`,
      payload: { coordinatorAgentId: '[Hermes] Lucy' },
    });
    expect(enabled.statusCode).toBe(201);
    expect(enabled.json().config).toMatchObject({
      conversationId: id,
      coordinatorAgentId: '[Hermes] Lucy',
    });
  });
});
