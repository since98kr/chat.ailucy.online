import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';
import type { ConversationApprovalBackend } from './openclaw-approval.js';
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

  it('deduplicates direct operations and rejects idempotency payload conflicts', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
    });
    const id = created.json().conversation.id as string;
    const clientMessageId = crypto.randomUUID();
    const idempotencyKey = `direct:${clientMessageId}`;
    const payload = {
      content: '중복 없이 한 번만 실행할 작업',
      clientMessageId,
      idempotencyKey,
    };

    const first = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-chat-idempotency']).toBe('new');
    expect(first.body).toContain('content.delta');
    const beforeReplay = (await app.inject({
      method: 'GET',
      url: `/api/conversations/${id}/operating-context`,
    })).json().operatingContext;

    const replay = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-chat-idempotency']).toBe('replayed');
    const replayEvents = replay.body.trim().split('\n').map((line) => JSON.parse(line) as StreamEvent);
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0]).toMatchObject({ type: 'message.accepted', message: { id: clientMessageId } });

    const afterReplay = (await app.inject({
      method: 'GET',
      url: `/api/conversations/${id}/operating-context`,
    })).json().operatingContext;
    expect(afterReplay.activeTask).toEqual(beforeReplay.activeTask);
    expect(afterReplay.continuationTarget).toEqual(beforeReplay.continuationTarget);

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: {
        content: '같은 키에 다른 요청을 넣으면 안 된다',
        clientMessageId: crypto.randomUUID(),
        idempotencyKey,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'DIRECT_MESSAGE_IDEMPOTENCY_CONFLICT' });

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    const messages = detail.json().conversation.messages as Array<{ role: string }>;
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('persists a server-owned operating context and binds continuation without replacing the active task', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
    });
    const id = created.json().conversation.id as string;

    const initial = await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().operatingContext).toMatchObject({
      conversationId: id,
      backendSystem: 'letta',
      agentId: '[Letta] Lucy',
      activeTask: null,
      continuationTarget: null,
      pendingApproval: null,
    });

    const first = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '실제 첫 작업을 이 대화의 중심으로 유지해줘.' },
    });
    expect(first.statusCode).toBe(200);
    const afterFirst = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
    expect(afterFirst.activeTask.label).toContain('실제 첫 작업');
    expect(afterFirst.continuationTarget.sessionIdentity).toBe(afterFirst.sessionIdentity);
    expect(afterFirst.statusTruth.at(-1)).toMatchObject({ classification: 'FACT' });

    const continued = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '계속해' },
    });
    expect(continued.statusCode).toBe(200);
    const afterContinue = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
    expect(afterContinue.activeTask).toEqual(afterFirst.activeTask);
    expect(afterContinue.continuationTarget).toEqual(afterFirst.continuationTarget);
  });

  it('fails closed for unbound continuation and bare approval before creating a message', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
    });
    const id = created.json().conversation.id as string;

    const continuation = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '계속해' },
    });
    expect(continuation.statusCode).toBe(409);
    expect(continuation.json()).toMatchObject({ error: 'CONTINUATION_BINDING_FAILED', reason: 'NO_CONTINUATION_TARGET' });

    const approval = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '승인' },
    });
    expect(approval.statusCode).toBe(409);
    expect(approval.json()).toMatchObject({ error: 'APPROVAL_BINDING_FAILED', reason: 'NO_PENDING_APPROVAL' });

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    expect(detail.json().conversation.messages).toHaveLength(0);
  });

  it('re-verifies one backend-owned approval and rejects replay after resolution', async () => {
    await app.close();
    const resolved = new Set<string>();
    const approvalBackend: ConversationApprovalBackend = {
      async listPending(context) {
        const approvalId = `approval:${context.conversationId}`;
        if (resolved.has(approvalId)) return [];
        return [{
          conversationId: context.conversationId,
          backendSystem: context.backendSystem,
          agentId: context.agentId,
          sessionIdentity: context.sessionIdentity,
          approvalId,
          kind: 'exec',
          summary: 'test protected action',
          state: 'pending',
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2099-09-01T00:00:00.000Z',
        }];
      },
      async resolvePending(context, approvalId) {
        const current = await this.listPending(context);
        if (!current.some((candidate) => candidate.approvalId === approvalId)) {
          throw new Error('not pending');
        }
        resolved.add(approvalId);
      },
    };
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
      approvalBackend,
    });
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
    });
    const id = created.json().conversation.id as string;

    const pending = await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` });
    expect(pending.json().operatingContext.pendingApproval).toMatchObject({
      approvalId: `approval:${id}`,
      state: 'pending',
    });

    const approved = await app.inject({ method: 'POST', url: `/api/conversations/${id}/approval` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      approvalId: `approval:${id}`,
      operatingContext: { pendingApproval: { state: 'approved' } },
    });
    expect(resolved.has(`approval:${id}`)).toBe(true);

    const replay = await app.inject({ method: 'POST', url: `/api/conversations/${id}/approval` });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: 'APPROVAL_BINDING_FAILED',
      reason: 'NO_PENDING_APPROVAL',
    });
  });

  it('preserves a newer blocker while an approval refresh is awaiting the backend', async () => {
    await app.close();
    let releasePending!: () => void;
    let markStarted!: () => void;
    const pendingStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const pendingGate = new Promise<void>((resolve) => { releasePending = resolve; });
    const approvalBackend: ConversationApprovalBackend = {
      async listPending() {
        markStarted();
        await pendingGate;
        return [];
      },
      async resolvePending() {
        throw new Error('not used');
      },
    };
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
      approvalBackend,
    });
    await app.ready();

    process.env.CHAT_TEST_MOCK_FAILURE_PATTERN = 'TEST_BACKEND_FAILURE_MARKER';
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
      });
      const id = created.json().conversation.id as string;

      const staleRefresh = app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` });
      await pendingStarted;

      const failed = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/messages/stream`,
        payload: { content: 'TEST_BACKEND_FAILURE_MARKER' },
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.body).toContain('run.failed');

      releasePending();
      expect((await staleRefresh).statusCode).toBe(200);
      const after = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
      expect(after.blocker).toMatchObject({
        summary: expect.stringContaining('Test backend failure'),
      });
    } finally {
      releasePending();
      delete process.env.CHAT_TEST_MOCK_FAILURE_PATTERN;
    }
  });

  it('preserves newer operating state while approval resolution awaits the backend', async () => {
    await app.close();
    let releaseResolve!: () => void;
    let markResolveStarted!: () => void;
    let resolved = false;
    const resolveStarted = new Promise<void>((resolve) => { markResolveStarted = resolve; });
    const resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const approvalBackend: ConversationApprovalBackend = {
      async listPending(context) {
        if (resolved) return [];
        return [{
          conversationId: context.conversationId,
          backendSystem: context.backendSystem,
          agentId: context.agentId,
          sessionIdentity: context.sessionIdentity,
          approvalId: `approval:${context.conversationId}`,
          kind: 'exec',
          summary: 'test protected action',
          state: 'pending',
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2099-09-01T00:00:00.000Z',
        }];
      },
      async resolvePending() {
        markResolveStarted();
        await resolveGate;
        resolved = true;
      },
    };
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
      approvalBackend,
    });
    await app.ready();

    process.env.CHAT_TEST_MOCK_FAILURE_PATTERN = 'TEST_BACKEND_FAILURE_MARKER';
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
      });
      const id = created.json().conversation.id as string;
      const approval = app.inject({ method: 'POST', url: `/api/conversations/${id}/approval` });
      await resolveStarted;
      const failed = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/messages/stream`,
        payload: { content: 'TEST_BACKEND_FAILURE_MARKER' },
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.body).toContain('run.failed');
      const during = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
      expect(during.activeTask.label).toBe('TEST_BACKEND_FAILURE_MARKER');
      expect(during.blocker).toMatchObject({ summary: expect.stringContaining('Test backend failure') });
      releaseResolve();
      const approved = await approval;
      expect(approved.statusCode).toBe(200);
      expect(approved.json().operatingContext).toMatchObject({
        activeTask: during.activeTask,
        blocker: during.blocker,
        pendingApproval: { approvalId: `approval:${id}`, state: 'approved' },
      });
      const after = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
      expect(after.activeTask).toEqual(during.activeTask);
      expect(after.blocker).toEqual(during.blocker);
      expect(after.statusTruth).toEqual(during.statusTruth);
      expect(after.pendingApproval).toBeNull();
    } finally {
      releaseResolve();
      delete process.env.CHAT_TEST_MOCK_FAILURE_PATTERN;
    }
  });

  it('answers status from bound truth, preserves blocker during status, and clears it only after successful continuation', async () => {
    process.env.CHAT_TEST_MOCK_FAILURE_PATTERN = 'TEST_BACKEND_FAILURE_MARKER';
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'letta', agentId: '[Letta] Lucy' },
      });
      const id = created.json().conversation.id as string;

      const failed = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/messages/stream`,
        payload: { content: 'TEST_BACKEND_FAILURE_MARKER' },
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.body).toContain('run.failed');
      const blocked = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
      expect(blocked.activeTask.label).toBe('TEST_BACKEND_FAILURE_MARKER');
      expect(blocked.blocker).toMatchObject({
        summary: expect.stringContaining('Test backend failure'),
        nextAction: expect.stringContaining('Retry or continue'),
      });

      const status = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/messages/stream`,
        payload: { content: '왜 안돼?' },
      });
      expect(status.statusCode).toBe(200);
      expect(status.body).toContain('BLOCKER');
      expect(status.body).toContain('NEXT ACTION');
      const afterStatus = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
      expect(afterStatus.activeTask).toEqual(blocked.activeTask);
      expect(afterStatus.continuationTarget).toEqual(blocked.continuationTarget);
      expect(afterStatus.blocker).toEqual(blocked.blocker);

      const continued = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/messages/stream`,
        payload: { content: '계속해' },
      });
      expect(continued.statusCode).toBe(200);
      expect(continued.body).toContain('run.completed');
      const recovered = (await app.inject({ method: 'GET', url: `/api/conversations/${id}/operating-context` })).json().operatingContext;
      expect(recovered.activeTask).toEqual(blocked.activeTask);
      expect(recovered.continuationTarget).toEqual(blocked.continuationTarget);
      expect(recovered.blocker).toBeNull();
      expect(recovered.statusTruth.at(-1)).toMatchObject({ classification: 'FACT' });
    } finally {
      delete process.env.CHAT_TEST_MOCK_FAILURE_PATTERN;
    }
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
    expect(search.json().results[0].conversation.id).toBe(id);
    expect(search.json().results[0].snippet).toContain('초정밀');

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
