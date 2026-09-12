import { describe, expect, it } from 'vitest';
import {
  createConversationOperatingContext,
  recordFailure,
} from '../shared/conversation-operating-context.js';
import {
  applyVerifiedExecutionCompletion,
  artifactExecutionEvidence,
  type RunExecutionEvidence,
  type RunExecutionIdentity,
} from './execution-evidence.js';

const contextIdentity = {
  conversationId: 'conversation-1',
  backendSystem: 'letta' as const,
  agentId: '[OpenClaw] Lucy',
  sessionIdentity: 'session-1',
};

const executionIdentity: RunExecutionIdentity = {
  runId: 'run-1',
  sessionId: 'session-1',
  operationId: 'operation-1',
};

function blockedContext() {
  return recordFailure(createConversationOperatingContext(contextIdentity), {
    blockerId: 'prior-run',
    summary: 'Backend execution could not be verified',
    nextAction: 'Retry the same bound task after verified result evidence is available.',
    evidenceRef: 'run:prior-run',
  });
}

describe('execution evidence contract', () => {
  it('keeps a commentary-only clean termination non-verified', () => {
    const before = blockedContext();
    const result = applyVerifiedExecutionCompletion(before, executionIdentity, []);

    expect(result.verified).toBe(false);
    expect(result.evidence).toBeNull();
    expect(result.context.statusTruth).toEqual(before.statusTruth);
    expect(result.context.blocker).toEqual(before.blocker);
    expect(result.context.nextAction).toBe(before.nextAction);
  });

  it('accepts concrete canonical evidence correlated to the current run/session/operation', () => {
    const evidence = artifactExecutionEvidence(executionIdentity, 'artifact-1');
    const result = applyVerifiedExecutionCompletion(blockedContext(), executionIdentity, [evidence]);

    expect(result.verified).toBe(true);
    expect(result.evidence).toEqual(evidence);
    expect(result.context.statusTruth.at(-1)).toMatchObject({
      classification: 'FACT',
      evidenceRef: 'run:run-1/artifact:artifact-1',
    });
    expect(result.context.blocker).toBeNull();
    expect(result.context.nextAction).toBeNull();
  });

  it('rejects evidence owned by another run, session, or operation', () => {
    const foreignEvidence: RunExecutionEvidence[] = [
      artifactExecutionEvidence({ ...executionIdentity, runId: 'run-other' }, 'artifact-run'),
      artifactExecutionEvidence({ ...executionIdentity, sessionId: 'session-other' }, 'artifact-session'),
      artifactExecutionEvidence({ ...executionIdentity, operationId: 'operation-other' }, 'artifact-operation'),
    ];

    const before = blockedContext();
    const result = applyVerifiedExecutionCompletion(before, executionIdentity, foreignEvidence);
    expect(result.verified).toBe(false);
    expect(result.context.statusTruth).toEqual(before.statusTruth);
    expect(result.context.blocker).toEqual(before.blocker);
  });

  it('retains blocker and next-action truth when execution remains unverifiable', () => {
    const before = blockedContext();
    const result = applyVerifiedExecutionCompletion(before, executionIdentity, [{
      ...executionIdentity,
      kind: 'result-receipt',
      evidenceRef: '',
    }]);

    expect(result.verified).toBe(false);
    expect(result.context.blocker).toEqual(before.blocker);
    expect(result.context.nextAction).toBe(before.nextAction);
  });
});
