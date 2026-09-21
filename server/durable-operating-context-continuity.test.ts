import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { ConversationApprovalBackend } from './openclaw-approval.js';
import type { StreamEvent } from '../shared/contracts.js';

const PROVIDER_ENV_KEYS = [
  'NODE_ENV',
  'OPENCLAW_BASE_URL',
  'OPENCLAW_PROTOCOL',
  'OPENCLAW_API_KEY',
  'OPENCLAW_AGENT_TARGET',
  'OPENCLAW_SESSION_PREFIX',
  'LETTA_BASE_URL',
  'LETTA_PROTOCOL',
  'LETTA_API_KEY',
  'LETTA_OPENCLAW_AGENT_TARGET',
  'LETTA_OPENCLAW_SESSION_PREFIX',
  'HERMES_BASE_URL',
] as const;

describe('durable Conversation operating-context continuity', () => {
  it('restores task, continuation, and the last verified approval snapshot across reload/reconnect', async () => {
    const previousEnv = Object.fromEntries(
      PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof PROVIDER_ENV_KEYS)[number], string | undefined>;
    process.env.NODE_ENV = 'test';
    delete process.env.OPENCLAW_BASE_URL;
    delete process.env.OPENCLAW_PROTOCOL;
    delete process.env.OPENCLAW_API_KEY;
    delete process.env.OPENCLAW_AGENT_TARGET;
    delete process.env.OPENCLAW_SESSION_PREFIX;
    delete process.env.LETTA_BASE_URL;
    delete process.env.LETTA_PROTOCOL;
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_OPENCLAW_AGENT_TARGET;
    delete process.env.LETTA_OPENCLAW_SESSION_PREFIX;
    delete process.env.HERMES_BASE_URL;

    // Adapter singletons are created when buildApp's module graph is loaded.
    // Reset and import only after provider configuration is cleared so this
    // deterministic source test can never inherit a real HTTP/OpenClaw route.
    vi.resetModules();
    const [{ buildApp }, { MockAdapter }] = await Promise.all([
      import('./index.js'),
      import('./adapters/mock.js'),
    ]);
    const mockStreamSpy = vi.spyOn(MockAdapter.prototype, 'streamReply');

    const directory = mkdtempSync(join(tmpdir(), 'chat-v2-durable-context-'));
    const databasePath = join(directory, 'chat.sqlite');
    const artifactRoot = join(directory, 'artifacts');
    let app: FastifyInstance | null = null;

    const onlineResolvePending = vi.fn(async () => {
      throw new Error('approval execution is outside this continuity proof');
    });
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
      resolvePending: onlineResolvePending,
    };

    const unavailableResolvePending = vi.fn(async () => {
      throw new Error('approval backend temporarily unavailable');
    });
    const unavailableApprovalBackend: ConversationApprovalBackend = {
      async listPending() {
        throw new Error('approval backend temporarily unavailable');
      },
      resolvePending: unavailableResolvePending,
    };

    try {
      app = buildApp({ databasePath, artifactRoot, approvalBackend: onlineApprovalBackend });
      await app.ready();

      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'openclaw', agentId: '[OpenClaw] Lucy' },
      });
      expect(created.statusCode).toBe(201);
      const conversationId = created.json().conversation.id as string;
      const expectedSessionIdentity = `openclaw:${conversationId}:[Letta] Lucy`;

      const first = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages/stream`,
        payload: { content: '이 작업을 재접속 뒤에도 그대로 이어가야 해.' },
      });
      expect(first.statusCode).toBe(200);
      const firstEvents = first.body.trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as StreamEvent);
      const firstAccepted = firstEvents.find((event) => event.type === 'message.accepted');
      expect(firstAccepted?.type).toBe('message.accepted');
      if (firstAccepted?.type !== 'message.accepted') throw new Error('Expected original task message');
      const originalTaskId = firstAccepted.message.id;
      expect(firstEvents.some((event) => event.type === 'run.completed')).toBe(true);

      const synchronized = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/operating-context`,
      });
      expect(synchronized.statusCode).toBe(200);
      const beforeReload = synchronized.json().operatingContext;
      expect(beforeReload).toMatchObject({
        conversationId,
        backendSystem: 'openclaw',
        agentId: '[OpenClaw] Lucy',
        sessionIdentity: expectedSessionIdentity,
        activeTask: {
          taskId: originalTaskId,
          label: expect.stringContaining('재접속'),
        },
        continuationTarget: {
          conversationId,
          backendSystem: 'openclaw',
          agentId: '[OpenClaw] Lucy',
          taskId: originalTaskId,
          sessionIdentity: expectedSessionIdentity,
        },
        pendingApproval: {
          conversationId,
          backendSystem: 'openclaw',
          agentId: '[OpenClaw] Lucy',
          approvalId: `approval:${conversationId}`,
          sessionIdentity: expectedSessionIdentity,
          state: 'pending',
          reason: 'durable approval reason',
          verificationPlan: 'verify durable outcome',
          rollbackPlan: 'restore durable state',
        },
      });
      expect(onlineResolvePending).not.toHaveBeenCalled();

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
      expect(afterReload).toMatchObject({
        conversationId,
        backendSystem: 'openclaw',
        agentId: '[OpenClaw] Lucy',
        sessionIdentity: expectedSessionIdentity,
        activeTask: beforeReload.activeTask,
        continuationTarget: {
          conversationId,
          backendSystem: 'openclaw',
          agentId: '[OpenClaw] Lucy',
          taskId: originalTaskId,
          sessionIdentity: expectedSessionIdentity,
        },
        pendingApproval: {
          conversationId,
          backendSystem: 'openclaw',
          agentId: '[OpenClaw] Lucy',
          approvalId: `approval:${conversationId}`,
          sessionIdentity: expectedSessionIdentity,
          state: 'pending',
        },
      });
      expect(afterReload.activeTask).toEqual(beforeReload.activeTask);
      expect(afterReload.continuationTarget).toEqual(beforeReload.continuationTarget);
      expect(afterReload.pendingApproval).toEqual(beforeReload.pendingApproval);
      expect(unavailableResolvePending).not.toHaveBeenCalled();

      const callsBeforeContinuation = mockStreamSpy.mock.calls.length;
      const continued = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages/stream`,
        payload: { content: '계속해' },
      });
      expect(continued.statusCode).toBe(200);
      const continuedEvents = continued.body.trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as StreamEvent);
      expect(continuedEvents.some((event) => event.type === 'run.completed')).toBe(true);
      expect(continuedEvents.some((event) => event.type.toLowerCase().includes('approval'))).toBe(false);
      expect(JSON.stringify(continuedEvents)).not.toContain(`approval:${conversationId}`);
      expect(onlineResolvePending).not.toHaveBeenCalled();
      expect(unavailableResolvePending).not.toHaveBeenCalled();

      expect(mockStreamSpy.mock.calls.length).toBe(callsBeforeContinuation + 1);
      const continuationRequest = mockStreamSpy.mock.calls.at(-1)?.[0];
      expect(continuationRequest).toMatchObject({
        userMessage: { content: '계속해' },
        targetAgentId: '[OpenClaw] Lucy',
        sessionId: expectedSessionIdentity,
        operatingIntent: 'continuation',
        operatingContext: {
          conversationId,
          backendSystem: 'openclaw',
          agentId: '[OpenClaw] Lucy',
          sessionIdentity: expectedSessionIdentity,
          activeTask: beforeReload.activeTask,
          continuationTarget: {
            conversationId,
            backendSystem: 'openclaw',
            agentId: '[OpenClaw] Lucy',
            taskId: originalTaskId,
            sessionIdentity: expectedSessionIdentity,
          },
        },
      });

      const afterContinueResponse = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/operating-context`,
      });
      expect(afterContinueResponse.statusCode).toBe(200);
      const afterContinue = afterContinueResponse.json().operatingContext;
      expect(afterContinue.activeTask).toEqual(beforeReload.activeTask);
      expect(afterContinue.continuationTarget).toEqual(beforeReload.continuationTarget);
      expect(afterContinue.pendingApproval).toEqual(beforeReload.pendingApproval);
      expect(unavailableResolvePending).not.toHaveBeenCalled();
    } finally {
      mockStreamSpy.mockRestore();
      if (app) await app.close();
      rmSync(directory, { recursive: true, force: true });
      for (const key of PROVIDER_ENV_KEYS) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
