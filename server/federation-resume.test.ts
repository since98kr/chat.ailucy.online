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

describe('Federated workflow resume', () => {
  let directory: string;
  let database: ChatDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-resume-'));
    database = new ChatDatabase(join(directory, 'chat.sqlite'));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('retries failed steps, leaves completed steps untouched, and runs the coordinator last', async () => {
    const collaboration = new CollaborationService(database);
    const federation = new FederationService(database);
    const conversation = database.createConversation('hermes', '[Hermes] Lucy', 'Resume test');
    collaboration.initializeConversation(conversation.id, 'hermes', '[Hermes] Lucy');
    federation.enableConversation(conversation.id, '[Hermes] Lucy');
    const userMessage = database.addMessage({
      conversationId: conversation.id,
      role: 'user',
      authorId: 'tei',
      content: '실패한 구현 step만 재개하고 종합해줘.',
    });
    const created = federation.createOrGetRun({
      conversationId: conversation.id,
      sourceMessageId: userMessage.id,
      idempotencyKey: 'resume-test-key',
      coordinatorAgentId: '[Hermes] Lucy',
      requestedAgentIds: ['Xixi', 'Lynn', '[Hermes] Lucy'],
    });
    const steps = federation.createSteps(created.run.id, [
      { agentId: 'Xixi', systemId: 'hermes', position: 0, parallelGroup: 0 },
      { agentId: 'Lynn', systemId: 'hermes', position: 1, parallelGroup: 0 },
      { agentId: '[Hermes] Lucy', systemId: 'hermes', position: 2, parallelGroup: 1, dependsOnStepIds: ['Xixi', 'Lynn'] },
    ]);
    const xixi = steps.find((step) => step.agentId === 'Xixi')!;
    const lynn = steps.find((step) => step.agentId === 'Lynn')!;
    const lynnOutput = database.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      authorId: 'Lynn',
      content: '이미 완료된 독립 검토',
      parentMessageId: userMessage.id,
    });
    federation.updateStep(xixi.id, { status: 'failed', error: 'simulated failure', incrementAttempt: true });
    federation.updateStep(lynn.id, { status: 'completed', outputMessageId: lynnOutput.id, incrementAttempt: true });
    federation.updateRun(created.run.id, { status: 'failed', error: 'simulated failure' });

    const streamed = [];
    for await (const event of runFederatedWorkflow({
      database,
      collaboration,
      federation,
      conversation: database.getConversation(conversation.id)!,
      userMessage,
      attachedArtifacts: [],
      idempotencyKey: created.run.idempotencyKey,
      requestedAgentIds: created.run.requestedAgentIds,
      signal: new AbortController().signal,
      existingRun: federation.getRun(created.run.id),
      resumed: true,
    })) streamed.push(event);

    const final = federation.getRun(created.run.id)!;
    expect(final.status).toBe('completed');
    expect(final.steps.find((step) => step.agentId === 'Xixi')).toMatchObject({ status: 'completed', attempt: 2 });
    expect(final.steps.find((step) => step.agentId === 'Lynn')).toMatchObject({ status: 'completed', attempt: 1, outputMessageId: lynnOutput.id });
    expect(final.steps.find((step) => step.agentId === '[Hermes] Lucy')).toMatchObject({ status: 'completed', attempt: 1 });
    expect(streamed.some((event) => event.type === 'workflow.event' && event.event.type === 'run.resumed')).toBe(true);
    expect(streamed.some((event) => event.type === 'run.started' && event.agentId === 'Lynn')).toBe(false);
  });
});
