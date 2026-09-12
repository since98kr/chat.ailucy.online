import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';

process.env.NODE_ENV = 'test';
delete process.env.LETTA_BASE_URL;
delete process.env.HERMES_BASE_URL;

const FAILURE_MARKER = 'TEST_EXECUTION_EVIDENCE_FAILURE';

async function createPersonalConversation(app: FastifyInstance) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { systemId: 'letta', agentId: '[OpenClaw] Lucy', title: 'Execution evidence test' },
  });
  expect(created.statusCode).toBe(201);
  return created.json().conversation.id as string;
}

async function send(app: FastifyInstance, conversationId: string, content: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages/stream`,
    payload: { content },
  });
  expect(response.statusCode).toBe(200);
  return response;
}

async function operatingContext(app: FastifyInstance, conversationId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/conversations/${conversationId}/operating-context`,
  });
  expect(response.statusCode).toBe(200);
  return response.json().operatingContext as {
    statusTruth: Array<{ classification: string; summary: string; evidenceRef: string | null }>;
    blocker: { blockerId: string; summary: string; nextAction: string } | null;
    nextAction: string | null;
  };
}

describe('runner execution evidence truth', () => {
  let directory: string;
  let app: FastifyInstance;
  let previousFailurePattern: string | undefined;

  beforeEach(async () => {
    previousFailurePattern = process.env.CHAT_TEST_MOCK_FAILURE_PATTERN;
    process.env.CHAT_TEST_MOCK_FAILURE_PATTERN = FAILURE_MARKER;
    directory = mkdtempSync(join(tmpdir(), 'chat-execution-evidence-'));
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousFailurePattern === undefined) delete process.env.CHAT_TEST_MOCK_FAILURE_PATTERN;
    else process.env.CHAT_TEST_MOCK_FAILURE_PATTERN = previousFailurePattern;
  });

  it('does not promote commentary-only clean stream termination to a verified execution fact', async () => {
    const id = await createPersonalConversation(app);
    await send(app, id, '설명만 제공하고 실행 결과는 만들지 마.');

    const context = await operatingContext(app, id);
    expect(context.statusTruth).toEqual([]);
    expect(context.blocker).toBeNull();
  });

  it('clears a blocker only after the current recovery run produces correlated artifact evidence', async () => {
    const id = await createPersonalConversation(app);
    await send(app, id, FAILURE_MARKER);

    const blocked = await operatingContext(app, id);
    expect(blocked.blocker?.summary).toContain(FAILURE_MARKER);
    expect(blocked.nextAction).toBeTruthy();

    const recovery = await send(app, id, '계속해');
    expect(recovery.body).toContain('artifact.created');

    const recovered = await operatingContext(app, id);
    expect(recovered.blocker).toBeNull();
    expect(recovered.nextAction).toBeNull();
    expect(recovered.statusTruth.at(-1)).toMatchObject({
      classification: 'FACT',
      summary: 'The latest bound Lucy run completed.',
    });
    expect(recovered.statusTruth.at(-1)?.evidenceRef).toMatch(/^run:/);
  });
});
