import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';
import type { ConversationApprovalBackend } from './openclaw-approval.js';

process.env.NODE_ENV = 'test';
delete process.env.LETTA_BASE_URL;
delete process.env.HERMES_BASE_URL;

describe('durable Conversation operating-context continuity', () => {
  it('restores task, continuation, and the last verified approval snapshot across reload/reconnect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat-v2-durable-context-'));
    const databasePath = join(directory, 'chat.sqlite');
    const artifactRoot = join(directory, 'artifacts');
    let app: FastifyInstance | null = null;

    const onlineApprovalBackend: ConversationApprovalBackend = {
      async listPending(context) {
        return [{
          conversationId: context.conversationId,
          backendSystem: context.backendSystem,
          agentId: context.agentId,
          sessionIdentity: context.sessionIdentity,
          approvalId: `approval:${context.conversationId}`,
          kind: 'exec',
          summary: 'durable protected action',
          reason: 'durable approval reason',
          verificationPlan: 'verify durable outcome',
          rollbackPlan: 'restore durable state',
          state: 'pending',
          createdAt: '2026-09-13T00:00:00.000Z',
          expiresAt: '2099-09-13T00:00:00.000Z',
        }];
      },
      async resolvePending() {
        throw new Error('approval execution is outside this continuity proof');
      },
    };

    const unavailableApprovalBackend: ConversationApprovalBackend = {
      async listPending() {
        throw new Error('approval backend temporarily unavailable');
      },
      async resolvePending() {
        throw new Error('approval backend temporarily unavailable');
      },
    };

    try {
      app = buildApp({ databasePath, artifactRoot, approvalBackend: onlineApprovalBackend });
      await app.ready();

      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'letta', agentId: '[OpenClaw] Lucy' },
      });
      expect(created.statusCode).toBe(201);
      const conversationId = created.json().conversation.id as string;

      const first = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages/stream`,
        payload: { content: '이 작업을 재접속 뒤에도 그대로 이어가야 해.' },
      });
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('run.completed');

      const synchronized = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/operating-context`,
      });
      expect(synchronized.statusCode).toBe(200);
      const beforeReload = synchronized.json().operatingContext;
      expect(beforeReload).toMatchObject({
        conversationId,
        backendSystem: 'letta',
        agentId: '[OpenClaw] Lucy',
        activeTask: { label: expect.stringContaining('재접속') },
        continuationTarget: {
          conversationId,
          taskId: beforeReload.activeTask.taskId,
          sessionIdentity: beforeReload.sessionIdentity,
        },
        pendingApproval: {
          approvalId: `approval:${conversationId}`,
          sessionIdentity: beforeReload.sessionIdentity,
          state: 'pending',
          reason: 'durable approval reason',
          verificationPlan: 'verify durable outcome',
          rollbackPlan: 'restore durable state',
        },
      });

      await app.close();
      app = null;

      app = buildApp({ databasePath, artifactRoot, approvalBackend: unavailableApprovalBackend });
      await app.ready();

      const restored = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/operating-context`,
      });
      expect(restored.statusCode).toBe(200);
      const afterReload = restored.json().operatingContext;
      expect(afterReload.conversationId).toBe(beforeReload.conversationId);
      expect(afterReload.backendSystem).toBe(beforeReload.backendSystem);
      expect(afterReload.agentId).toBe(beforeReload.agentId);
      expect(afterReload.sessionIdentity).toBe(beforeReload.sessionIdentity);
      expect(afterReload.activeTask).toEqual(beforeReload.activeTask);
      expect(afterReload.continuationTarget).toEqual(beforeReload.continuationTarget);
      expect(afterReload.pendingApproval).toEqual(beforeReload.pendingApproval);

      const continued = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages/stream`,
        payload: { content: '계속해' },
      });
      expect(continued.statusCode).toBe(200);
      expect(continued.body).toContain('run.completed');

      const afterContinueResponse = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/operating-context`,
      });
      expect(afterContinueResponse.statusCode).toBe(200);
      const afterContinue = afterContinueResponse.json().operatingContext;
      expect(afterContinue.activeTask).toEqual(beforeReload.activeTask);
      expect(afterContinue.continuationTarget).toEqual(beforeReload.continuationTarget);
      expect(afterContinue.pendingApproval).toEqual(beforeReload.pendingApproval);
    } finally {
      if (app) await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
