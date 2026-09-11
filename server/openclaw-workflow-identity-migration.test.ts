import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatDatabase } from './database.js';
import { CollaborationService } from './collaboration.js';
import { FederationService } from './federation.js';
import { runFederatedWorkflow } from './federated-runner.js';

process.env.NODE_ENV = 'test';
delete process.env.LETTA_BASE_URL;
delete process.env.HERMES_BASE_URL;

describe('OpenClaw Lucy workflow identity migration', () => {
  let directory: string;
  let database: ChatDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'chat-openclaw-workflow-migration-'));
    database = new ChatDatabase(join(directory, 'chat.sqlite'));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('migrates a resumable legacy Letta step without changing dependency UUIDs and resumes it as OpenClaw Lucy', async () => {
    const collaboration = new CollaborationService(database);
    const federation = new FederationService(database);
    const stamp = new Date().toISOString();

    database.db.prepare(`
      INSERT INTO agents (
        id, system_id, display_name, short_name, role, description,
        capabilities_json, enabled, direct_chat_enabled, is_lead,
        sort_order, created_at, updated_at
      ) VALUES (?, 'letta', ?, 'Lucy', 'Personal AI', 'legacy', '[]', 1, 1, 1, 5, ?, ?)
    `).run('[Letta] Lucy', '[Letta] Lucy', stamp, stamp);

    const conversation = database.createConversation('hermes', '[Hermes] Lucy', 'Legacy workflow migration');
    collaboration.initializeConversation(conversation.id, 'hermes', '[Hermes] Lucy');
    federation.enableConversation(conversation.id, '[Hermes] Lucy');
    const userMessage = database.addMessage({
      conversationId: conversation.id,
      role: 'user',
      authorId: 'tei',
      content: '기존 개인 Lucy 단계와 Hermes 종합을 이어서 완료해줘.',
    });
    const created = federation.createOrGetRun({
      conversationId: conversation.id,
      sourceMessageId: userMessage.id,
      idempotencyKey: 'legacy-openclaw-resume',
      coordinatorAgentId: '[Hermes] Lucy',
      requestedAgentIds: ['[Letta] Lucy', '[Hermes] Lucy'],
    });
    const steps = federation.createSteps(created.run.id, [
      { agentId: '[Letta] Lucy', systemId: 'letta', position: 0, parallelGroup: 0 },
      {
        agentId: '[Hermes] Lucy',
        systemId: 'hermes',
        position: 1,
        parallelGroup: 1,
        dependsOnStepIds: ['[Letta] Lucy'],
      },
    ]);
    const legacyStep = steps.find((step) => step.agentId === '[Letta] Lucy')!;
    const coordinatorStep = steps.find((step) => step.agentId === '[Hermes] Lucy')!;
    const dependencyIdsBefore = [...coordinatorStep.dependsOnStepIds];
    federation.updateStep(legacyStep.id, { status: 'failed', error: 'legacy pause', incrementAttempt: true });
    federation.updateRun(created.run.id, { status: 'failed', error: 'legacy pause' });

    const migratedCollaboration = new CollaborationService(database);
    const migratedFederation = new FederationService(database);
    const migrated = migratedFederation.getRun(created.run.id)!;

    expect(migrated.requestedAgentIds).toEqual(['[OpenClaw] Lucy', '[Hermes] Lucy']);
    expect(migrated.steps.find((step) => step.systemId === 'letta')).toMatchObject({
      id: legacyStep.id,
      agentId: '[OpenClaw] Lucy',
      status: 'failed',
      attempt: 1,
    });
    expect(migrated.steps.find((step) => step.id === coordinatorStep.id)?.dependsOnStepIds).toEqual(dependencyIdsBefore);
    expect(migratedCollaboration.getAgent('[Letta] Lucy')).toMatchObject({ enabled: false });
    expect(migratedCollaboration.getAgent('[OpenClaw] Lucy')).toMatchObject({ enabled: true, directChatEnabled: true });

    const streamed = [];
    for await (const event of runFederatedWorkflow({
      database,
      collaboration: migratedCollaboration,
      federation: migratedFederation,
      conversation: database.getConversation(conversation.id)!,
      userMessage,
      attachedArtifacts: [],
      idempotencyKey: migrated.idempotencyKey,
      requestedAgentIds: migrated.requestedAgentIds,
      signal: new AbortController().signal,
      existingRun: migrated,
      resumed: true,
    })) streamed.push(event);

    const final = migratedFederation.getRun(created.run.id)!;
    expect(final.status).toBe('completed');
    expect(final.steps.find((step) => step.agentId === '[OpenClaw] Lucy')).toMatchObject({
      status: 'completed',
      attempt: 2,
    });
    expect(final.steps.find((step) => step.agentId === '[Hermes] Lucy')).toMatchObject({ status: 'completed' });
    expect(streamed.some((event) => event.type === 'workflow.event' && event.event.type === 'run.resumed')).toBe(true);
  });
});
