import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';

process.env.NODE_ENV = 'test';

describe('federation conversation identity guard', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-federation-identity-'));
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects federation on a personal Letta conversation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[Letta] Lucy', title: 'Personal Lucy' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().conversation.id as string;

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

  it('still allows federation on an explicit Hermes Lucy conversation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Hermes federation' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().conversation.id as string;

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
