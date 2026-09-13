import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';

const PROVIDER_ENV_KEYS = [
  'NODE_ENV',
  'HERMES_BASE_URL',
  'HERMES_API_KEY',
  'HERMES_PROTOCOL',
  'HERMES_MODEL_MAP_JSON',
  'HERMES_ARTIFACT_ENVELOPE_ENABLED',
] as const;

function events(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

describe('direct-agent Conversation isolation', () => {
  it('keeps Lucy and Xixi task, session, activity, and artifact state isolated across direct Conversations', async () => {
    const previousEnv = Object.fromEntries(
      PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof PROVIDER_ENV_KEYS)[number], string | undefined>;
    process.env.NODE_ENV = 'test';
    delete process.env.HERMES_BASE_URL;
    delete process.env.HERMES_API_KEY;
    delete process.env.HERMES_PROTOCOL;
    delete process.env.HERMES_MODEL_MAP_JSON;
    delete process.env.HERMES_ARTIFACT_ENVELOPE_ENABLED;

    // Adapter singletons are selected during the server module import. Force a
    // clean module graph only after real-provider configuration is removed.
    vi.resetModules();
    const [{ buildApp }, { MockAdapter }, { ChatDatabase }] = await Promise.all([
      import('./index.js'),
      import('./adapters/mock.js'),
      import('./database.js'),
    ]);
    const mockStreamSpy = vi.spyOn(MockAdapter.prototype, 'streamReply');

    const directory = mkdtempSync(join(tmpdir(), 'chat-v2-cross-agent-isolation-'));
    const databasePath = join(directory, 'chat.sqlite');
    let app: FastifyInstance | null = null;

    try {
      app = buildApp({
        databasePath,
        artifactRoot: join(directory, 'artifacts'),
      });
      await app.ready();

      const lucyCreated = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Lucy isolation lane' },
      });
      const xixiCreated = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { systemId: 'hermes', agentId: 'Xixi', title: 'Xixi isolation lane' },
      });
      expect(lucyCreated.statusCode).toBe(201);
      expect(xixiCreated.statusCode).toBe(201);
      const lucyId = lucyCreated.json().conversation.id as string;
      const xixiId = xixiCreated.json().conversation.id as string;
      expect(lucyId).not.toBe(xixiId);

      const lucyStream = await app.inject({
        method: 'POST',
        url: `/api/conversations/${lucyId}/messages/stream`,
        payload: { content: 'LUCY_PRIVATE_TASK', artifactIds: [] },
      });
      const xixiStream = await app.inject({
        method: 'POST',
        url: `/api/conversations/${xixiId}/messages/stream`,
        payload: { content: 'XIXI_PRIVATE_TASK', artifactIds: [] },
      });
      expect(lucyStream.statusCode).toBe(200);
      expect(xixiStream.statusCode).toBe(200);

      const lucyEvents = events(lucyStream.body);
      const xixiEvents = events(xixiStream.body);
      const lucyAccepted = lucyEvents.find((event) => event.type === 'message.accepted');
      const xixiAccepted = xixiEvents.find((event) => event.type === 'message.accepted');
      const lucyCompleted = lucyEvents.find((event) => event.type === 'run.completed');
      const xixiCompleted = xixiEvents.find((event) => event.type === 'run.completed');
      expect(lucyAccepted?.type).toBe('message.accepted');
      expect(xixiAccepted?.type).toBe('message.accepted');
      expect(lucyCompleted?.type).toBe('run.completed');
      expect(xixiCompleted?.type).toBe('run.completed');
      if (
        lucyAccepted?.type !== 'message.accepted'
        || xixiAccepted?.type !== 'message.accepted'
        || lucyCompleted?.type !== 'run.completed'
        || xixiCompleted?.type !== 'run.completed'
      ) throw new Error('Expected isolated direct-agent runs');

      expect(lucyEvents.find((event) => event.type === 'routing.resolved')).toMatchObject({
        routing: { mode: 'lead', targetAgentIds: ['[Hermes] Lucy'] },
      });
      expect(xixiEvents.find((event) => event.type === 'routing.resolved')).toMatchObject({
        routing: { mode: 'direct', targetAgentIds: ['Xixi'] },
      });

      expect(mockStreamSpy.mock.calls).toHaveLength(2);
      const lucyRequest = mockStreamSpy.mock.calls[0][0];
      const xixiRequest = mockStreamSpy.mock.calls[1][0];
      const expectedLucySession = `hermes:${lucyId}:[Hermes] Lucy`;
      const expectedXixiSession = `hermes:${xixiId}:Xixi`;
      expect(lucyRequest).toMatchObject({
        targetAgentId: '[Hermes] Lucy',
        sessionId: expectedLucySession,
        conversation: { id: lucyId, systemId: 'hermes', agentId: '[Hermes] Lucy' },
        userMessage: { id: lucyAccepted.message.id, content: 'LUCY_PRIVATE_TASK' },
      });
      expect(xixiRequest).toMatchObject({
        targetAgentId: 'Xixi',
        sessionId: expectedXixiSession,
        conversation: { id: xixiId, systemId: 'hermes', agentId: 'Xixi' },
        userMessage: { id: xixiAccepted.message.id, content: 'XIXI_PRIVATE_TASK' },
      });
      expect(lucyRequest.sessionId).not.toBe(xixiRequest.sessionId);

      const lucyContextResponse = await app.inject({
        method: 'GET',
        url: `/api/conversations/${lucyId}/operating-context`,
      });
      const xixiContextResponse = await app.inject({
        method: 'GET',
        url: `/api/conversations/${xixiId}/operating-context`,
      });
      expect(lucyContextResponse.statusCode).toBe(200);
      expect(xixiContextResponse.statusCode).toBe(200);
      const lucyContext = lucyContextResponse.json().operatingContext as {
        conversationId: string;
        backendSystem: string;
        agentId: string;
        sessionIdentity: string;
        activeTask: { taskId: string } | null;
      };
      const xixiContext = xixiContextResponse.json().operatingContext as typeof lucyContext;
      expect(lucyContext).toMatchObject({
        conversationId: lucyId,
        backendSystem: 'hermes',
        agentId: '[Hermes] Lucy',
        sessionIdentity: expectedLucySession,
        activeTask: { taskId: lucyAccepted.message.id },
      });
      expect(xixiContext).toMatchObject({
        conversationId: xixiId,
        backendSystem: 'hermes',
        agentId: 'Xixi',
        sessionIdentity: expectedXixiSession,
        activeTask: { taskId: xixiAccepted.message.id },
      });
      expect(lucyContext.activeTask?.taskId).not.toBe(xixiContext.activeTask?.taskId);
      expect(lucyContext.sessionIdentity).not.toBe(xixiContext.sessionIdentity);

      const lucyActivityResponse = await app.inject({
        method: 'GET',
        url: `/api/conversations/${lucyId}/team-activity`,
      });
      const xixiActivityResponse = await app.inject({
        method: 'GET',
        url: `/api/conversations/${xixiId}/team-activity`,
      });
      expect(lucyActivityResponse.statusCode).toBe(200);
      expect(xixiActivityResponse.statusCode).toBe(200);
      const lucyOutputs = (lucyActivityResponse.json().activities as Array<{ agentId: string; type: string }>)
        .filter((activity) => activity.type === 'output')
        .map((activity) => activity.agentId);
      const xixiOutputs = (xixiActivityResponse.json().activities as Array<{ agentId: string; type: string }>)
        .filter((activity) => activity.type === 'output')
        .map((activity) => activity.agentId);
      expect(lucyOutputs).toEqual(['[Hermes] Lucy']);
      expect(xixiOutputs).toEqual(['Xixi']);

      await app.close();
      app = null;

      const database = new ChatDatabase(databasePath);
      const lucyOnlyArtifact = database.addArtifact({
        conversationId: lucyId,
        messageId: null,
        filename: 'lucy-only.txt',
        mimeType: 'text/plain',
        sizeBytes: 9,
        storagePath: join(directory, 'lucy-only.txt'),
      });
      expect(() => database.attachArtifacts(xixiId, [lucyOnlyArtifact.id], xixiAccepted.message.id))
        .toThrow('One or more artifacts are unavailable for this Conversation');
      expect(database.getArtifact(lucyOnlyArtifact.id)).toMatchObject({
        conversationId: lucyId,
        messageId: null,
      });
      expect(database.getConversation(xixiId)?.artifacts.some((artifact) => artifact.id === lucyOnlyArtifact.id)).toBe(false);
      database.close();
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
