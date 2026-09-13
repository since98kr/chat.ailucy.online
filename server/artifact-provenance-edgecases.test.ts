import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent, WorkflowRunRecord } from '../shared/contracts.js';

process.env.NODE_ENV = 'test';

function events(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

describe('generated artifact provenance edge cases', () => {
  let directory: string;
  let backend: Server;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-artifact-provenance-edge-'));
    backend = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write(`${JSON.stringify({
          type: 'artifact.created',
          artifact: {
            filename: `edge-${crypto.randomUUID()}.txt`,
            mime_type: 'text/plain',
            content_text: 'EDGE_PROVENANCE_RESULT',
          },
        })}\n`);
        response.end('{"delta":"done"}\n');
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const address = backend.address() as AddressInfo;
    process.env.HERMES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.HERMES_CHAT_PATH = '/v1/chat/completions';
    process.env.HERMES_HEALTH_PATH = '/health';
    process.env.HERMES_PROTOCOL = 'openai';
    process.env.HERMES_MODEL_MAP_JSON = JSON.stringify({
      '[Hermes] Lucy': 'artifact-owner-model',
      Xixi: 'artifact-owner-model',
    });
    delete process.env.LETTA_BASE_URL;
    vi.resetModules();
    const { buildApp } = await import('./index.js');
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
    delete process.env.HERMES_BASE_URL;
    delete process.env.HERMES_CHAT_PATH;
    delete process.env.HERMES_HEALTH_PATH;
    delete process.env.HERMES_PROTOCOL;
    delete process.env.HERMES_MODEL_MAP_JSON;
    vi.resetModules();
  });

  it('persists federated generated artifacts with workflow run and exact producing step ownership', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Federated artifact owner', federated: true },
    });
    const conversationId = created.json().conversation.id as string;
    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: {
        content: 'Xixi와 함께 artifact를 생성해줘.',
        targetAgentIds: ['Xixi'],
        workflowMode: 'federated',
        idempotencyKey: 'federated-artifact-owner-1',
      },
    });
    expect(streamed.statusCode).toBe(200);

    const snapshot = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/federation` });
    const run = snapshot.json().federation.runs[0] as WorkflowRunRecord;
    expect(run.status).toBe('completed');

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    const conversation = detail.json().conversation as {
      artifacts: Array<{ messageId: string | null; producerRunId: string | null; producerTaskId: string | null }>;
    };
    expect(conversation.artifacts.length).toBeGreaterThanOrEqual(2);
    for (const artifact of conversation.artifacts) {
      const producingStep = run.steps.find((step) => step.outputMessageId === artifact.messageId);
      expect(producingStep).toBeDefined();
      expect(artifact.producerRunId).toBe(run.id);
      expect(artifact.producerTaskId).toBe(producingStep?.id);
    }
  });

  it('keeps a regenerated sibling artifact bound to the original source task after a newer task becomes active', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Retry artifact owner' },
    });
    const conversationId = created.json().conversation.id as string;

    const first = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: '@Xixi 첫 작업 artifact를 만들어줘.', artifactIds: [] },
    });
    const firstEvents = events(first.body);
    const firstAccepted = firstEvents.find((event) => event.type === 'message.accepted');
    const xixiCompleted = firstEvents.find((event) => event.type === 'run.completed' && event.agentId === 'Xixi');
    expect(firstAccepted?.type).toBe('message.accepted');
    expect(xixiCompleted?.type).toBe('run.completed');
    if (firstAccepted?.type !== 'message.accepted' || xixiCompleted?.type !== 'run.completed') {
      throw new Error('Expected the original user task and Xixi response');
    }

    const second = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: '이것이 더 최신의 별도 작업이다.', artifactIds: [] },
    });
    const secondAccepted = events(second.body).find((event) => event.type === 'message.accepted');
    expect(secondAccepted?.type).toBe('message.accepted');
    if (secondAccepted?.type !== 'message.accepted') throw new Error('Expected newer task');

    const context = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/operating-context` });
    expect(context.json().operatingContext.activeTask.taskId).toBe(secondAccepted.message.id);
    expect(secondAccepted.message.id).not.toBe(firstAccepted.message.id);

    const retried = await app.inject({
      method: 'POST',
      url: `/api/messages/${xixiCompleted.message.id}/retry/stream`,
      payload: { mode: 'regenerate', idempotencyKey: `edge-retry-${crypto.randomUUID()}` },
    });
    expect(retried.statusCode).toBe(200);
    const retryEvents = events(retried.body);
    const retryCreated = retryEvents.find((event) => event.type === 'message.created');
    const retryArtifact = retryEvents.find((event) => event.type === 'artifact.created');
    expect(retryCreated?.type).toBe('message.created');
    expect(retryArtifact?.type).toBe('artifact.created');
    if (retryCreated?.type !== 'message.created' || retryArtifact?.type !== 'artifact.created') {
      throw new Error('Expected regenerated message and artifact');
    }
    expect(retryArtifact.artifact.messageId).toBe(retryCreated.message.id);
    expect(retryArtifact.artifact.producerTaskId).toBe(firstAccepted.message.id);
    expect(retryArtifact.artifact.producerTaskId).not.toBe(secondAccepted.message.id);
  });

  it('replays the original bound task when regenerating a continuation artifact after a newer task', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Continuation artifact owner' },
    });
    const conversationId = created.json().conversation.id as string;

    const ordinary = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: '기준 작업을 시작해.', artifactIds: [] },
    });
    const ordinaryAccepted = events(ordinary.body).find((event) => event.type === 'message.accepted');
    expect(ordinaryAccepted?.type).toBe('message.accepted');
    if (ordinaryAccepted?.type !== 'message.accepted') throw new Error('Expected ordinary task');

    const continuation = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: '계속해', artifactIds: [] },
    });
    const continuationEvents = events(continuation.body);
    const continuationAccepted = continuationEvents.find((event) => event.type === 'message.accepted');
    const continuationCompleted = continuationEvents.find(
      (event) => event.type === 'run.completed' && event.agentId === '[Hermes] Lucy',
    );
    const originalContinuationArtifact = continuationEvents.find((event) => event.type === 'artifact.created');
    expect(continuationAccepted?.type).toBe('message.accepted');
    expect(continuationCompleted?.type).toBe('run.completed');
    expect(originalContinuationArtifact?.type).toBe('artifact.created');
    if (
      continuationAccepted?.type !== 'message.accepted'
      || continuationCompleted?.type !== 'run.completed'
      || originalContinuationArtifact?.type !== 'artifact.created'
    ) throw new Error('Expected continuation response and artifact');
    expect(originalContinuationArtifact.artifact.producerTaskId).toBe(ordinaryAccepted.message.id);
    expect(originalContinuationArtifact.artifact.producerTaskId).not.toBe(continuationAccepted.message.id);

    const newer = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: { content: '완전히 새로운 작업을 시작해.', artifactIds: [] },
    });
    const newerAccepted = events(newer.body).find((event) => event.type === 'message.accepted');
    expect(newerAccepted?.type).toBe('message.accepted');
    if (newerAccepted?.type !== 'message.accepted') throw new Error('Expected newer task');

    const retried = await app.inject({
      method: 'POST',
      url: `/api/messages/${continuationCompleted.message.id}/retry/stream`,
      payload: { mode: 'regenerate', idempotencyKey: `continuation-retry-${crypto.randomUUID()}` },
    });
    expect(retried.statusCode).toBe(200);
    const retryArtifact = events(retried.body).find((event) => event.type === 'artifact.created');
    expect(retryArtifact?.type).toBe('artifact.created');
    if (retryArtifact?.type !== 'artifact.created') throw new Error('Expected regenerated continuation artifact');
    expect(retryArtifact.artifact.producerTaskId).toBe(ordinaryAccepted.message.id);
    expect(retryArtifact.artifact.producerTaskId).not.toBe(continuationAccepted.message.id);
    expect(retryArtifact.artifact.producerTaskId).not.toBe(newerAccepted.message.id);
  });

  it('keeps a regenerated branched status artifact unbound when the original execution had no active task', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Branched unbound status owner' },
    });
    const sourceId = created.json().conversation.id as string;
    const source = await app.inject({
      method: 'POST',
      url: `/api/conversations/${sourceId}/messages/stream`,
      payload: { content: '원본 대화의 작업이다.', artifactIds: [] },
    });
    expect(source.statusCode).toBe(200);

    const branched = await app.inject({ method: 'POST', url: `/api/conversations/${sourceId}/branch`, payload: {} });
    expect(branched.statusCode).toBe(201);
    const branchId = branched.json().conversation.id as string;
    const beforeStatus = await app.inject({ method: 'GET', url: `/api/conversations/${branchId}/operating-context` });
    expect(beforeStatus.json().operatingContext.activeTask).toBeNull();

    const status = await app.inject({
      method: 'POST',
      url: `/api/conversations/${branchId}/messages/stream`,
      payload: { content: '현황 알려줘', artifactIds: [] },
    });
    expect(status.statusCode).toBe(200);
    const statusEvents = events(status.body);
    const statusArtifact = statusEvents.find((event) => event.type === 'artifact.created');
    const statusCompleted = statusEvents.find(
      (event) => event.type === 'run.completed' && event.agentId === '[Hermes] Lucy',
    );
    expect(statusArtifact?.type).toBe('artifact.created');
    expect(statusCompleted?.type).toBe('run.completed');
    if (statusArtifact?.type !== 'artifact.created' || statusCompleted?.type !== 'run.completed') {
      throw new Error('Expected unbound status response and artifact');
    }
    expect(statusArtifact.artifact.producerTaskId).toBeNull();

    const retried = await app.inject({
      method: 'POST',
      url: `/api/messages/${statusCompleted.message.id}/retry/stream`,
      payload: { mode: 'regenerate', idempotencyKey: `branched-status-retry-${crypto.randomUUID()}` },
    });
    expect(retried.statusCode).toBe(200);
    const retryArtifact = events(retried.body).find((event) => event.type === 'artifact.created');
    expect(retryArtifact?.type).toBe('artifact.created');
    if (retryArtifact?.type !== 'artifact.created') throw new Error('Expected regenerated status artifact');
    expect(retryArtifact.artifact.producerTaskId).toBeNull();
  });
});
