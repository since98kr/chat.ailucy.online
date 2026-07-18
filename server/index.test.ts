import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';
import type { StreamEvent } from '../shared/contracts.js';

process.env.NODE_ENV = 'test';
delete process.env.LETTA_BASE_URL;
delete process.env.HERMES_BASE_URL;

describe('Chat Core API', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-'));
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

  it('creates, renames, archives, trashes, and deletes a Conversation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy' },
    });
    expect(created.statusCode).toBe(201);
    const conversation = created.json().conversation as { id: string; title: string };
    expect(conversation.title).toBe('새 대화');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversation.id}`,
      payload: { title: 'API 통합 테스트', pinned: true },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().conversation).toMatchObject({ title: 'API 통합 테스트', pinned: true });

    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversation.id}`,
      payload: { status: 'archived' },
    });
    expect(archived.json().conversation.status).toBe('archived');

    const trashed = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversation.id}`,
      payload: { status: 'trashed' },
    });
    expect(trashed.json().conversation.status).toBe('trashed');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/conversations/${conversation.id}` });
    expect(deleted.statusCode).toBe(204);
    const missing = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('persists user and streamed assistant messages', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
    });
    const id = created.json().conversation.id as string;
    const clientMessageId = crypto.randomUUID();

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '이번 주 우선순위를 정리해줘.', clientMessageId },
    });

    expect(streamed.statusCode).toBe(200);
    const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    expect(events.some((event) => event.type === 'message.accepted')).toBe(true);
    expect(events.some((event) => event.type === 'content.delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('run.completed');

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    const messages = detail.json().conversation.messages as Array<{ role: string; content: string; state: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: '이번 주 우선순위를 정리해줘.' });
    expect(messages[1].content).toContain('[Letta] Lucy');
    expect(messages[1].state).toBe('complete');
  });

  it('searches message content and branches a Conversation at a selected message', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: '드론 프로젝트' },
    });
    const id = created.json().conversation.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '액화수소 드론의 초정밀 위치 활용을 분석해줘.' },
    });

    const search = await app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent('초정밀')}&systemId=hermes`,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results[0]).toMatchObject({
      conversation: { id },
      matchedIn: 'message',
    });

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    const lastMessage = detail.json().conversation.messages.at(-1) as { id: string };
    const branched = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/branch`,
      payload: { fromMessageId: lastMessage.id, title: '드론 프로젝트 · 위치 활용' },
    });
    expect(branched.statusCode).toBe(201);
    expect(branched.json().conversation).toMatchObject({
      title: '드론 프로젝트 · 위치 활용',
      branchedFromConversationId: id,
      branchedFromMessageId: lastMessage.id,
    });
    expect(branched.json().conversation.messages).toHaveLength(2);
  });

  it('exports a Conversation as Markdown', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/conversations/chat-v2/export/markdown' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.body).toContain('# Chat V2 개발');
    expect(response.body).toContain('[Hermes] Lucy');
  });

  it('reports adapter mode and rejects permanent deletion before Trash', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().adapters).toMatchObject({
      letta: { ok: true, mode: 'mock' },
      hermes: { ok: true, mode: 'mock' },
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/conversations/chat-v2' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('CONVERSATION_MUST_BE_TRASHED_FIRST');
  });
});
