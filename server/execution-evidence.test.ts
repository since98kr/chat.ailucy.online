import { describe, expect, it } from 'vitest';
import {
  createConversationOperatingContext,
  recordFailure,
} from '../shared/conversation-operating-context.js';
import {
  applyVerifiedExecutionCompletion,
  providerExecutionEvidence,
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

  it('accepts an explicit provider receipt only when session and operation identities match', () => {
    const evidence = providerExecutionEvidence(executionIdentity, {
      kind: 'result-receipt',
      sessionId: 'session-1',
      operationId: 'operation-1',
      receiptId: 'provider-result-001',
    });
    expect(evidence).not.toBeNull();

    const result = applyVerifiedExecutionCompletion(blockedContext(), executionIdentity, [evidence!]);
    expect(result.verified).toBe(true);
    expect(result.evidence).toEqual(evidence);
    expect(result.context.statusTruth.at(-1)).toMatchObject({
      classification: 'FACT',
      evidenceRef: 'provider-receipt:provider-result-001',
    });
    expect(result.context.blocker).toBeNull();
    expect(result.context.nextAction).toBeNull();
  });

  it('rejects provider receipts for another session or operation', () => {
    expect(providerExecutionEvidence(executionIdentity, {
      kind: 'result-receipt',
      sessionId: 'session-other',
      operationId: 'operation-1',
      receiptId: 'foreign-session',
    })).toBeNull();
    expect(providerExecutionEvidence(executionIdentity, {
      kind: 'tool-receipt',
      sessionId: 'session-1',
      operationId: 'operation-other',
      receiptId: 'foreign-operation',
    })).toBeNull();
  });

  it('rejects already-constructed evidence owned by another run', () => {
    const foreignEvidence: RunExecutionEvidence = {
      runId: 'run-other',
      sessionId: 'session-1',
      operationId: 'operation-1',
      kind: 'result-receipt',
      evidenceRef: 'provider-receipt:foreign-run',
    };
    const before = blockedContext();
    const result = applyVerifiedExecutionCompletion(before, executionIdentity, [foreignEvidence]);
    expect(result.verified).toBe(false);
    expect(result.context.statusTruth).toEqual(before.statusTruth);
    expect(result.context.blocker).toEqual(before.blocker);
  });

  it('rejects unsafe or blank provider receipt identifiers', () => {
    expect(providerExecutionEvidence(executionIdentity, {
      kind: 'result-receipt',
      sessionId: 'session-1',
      operationId: 'operation-1',
      receiptId: '',
    })).toBeNull();
    expect(providerExecutionEvidence(executionIdentity, {
      kind: 'result-receipt',
      sessionId: 'session-1',
      operationId: 'operation-1',
      receiptId: 'https://provider.invalid/result?token=secret',
    })).toBeNull();
  });

  it('retains blocker and next-action truth when execution remains unverifiable', () => {
    const before = blockedContext();
    const result = applyVerifiedExecutionCompletion(before, executionIdentity, []);

    expect(result.verified).toBe(false);
    expect(result.context.blocker).toEqual(before.blocker);
    expect(result.context.nextAction).toBe(before.nextAction);
  });
});
