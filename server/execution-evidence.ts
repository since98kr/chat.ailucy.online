import {
  recordVerifiedFact,
  type ConversationOperatingContext,
} from '../shared/conversation-operating-context.js';

export type RunExecutionEvidenceKind = 'artifact' | 'tool-receipt' | 'result-receipt';

export type RunExecutionIdentity = {
  runId: string;
  sessionId: string;
  operationId: string;
};

export type RunExecutionEvidence = RunExecutionIdentity & {
  kind: RunExecutionEvidenceKind;
  evidenceRef: string;
};

function nonBlank(value: string) {
  return value.trim().length > 0;
}

export function artifactExecutionEvidence(
  identity: RunExecutionIdentity,
  artifactId: string,
): RunExecutionEvidence {
  if (!nonBlank(artifactId)) throw new Error('artifactId must be non-empty');
  return {
    ...identity,
    kind: 'artifact',
    evidenceRef: `run:${identity.runId}/artifact:${artifactId}`,
  };
}

export function verifiedExecutionEvidence(
  evidence: readonly RunExecutionEvidence[],
  expected: RunExecutionIdentity,
): RunExecutionEvidence | null {
  if (!nonBlank(expected.runId) || !nonBlank(expected.sessionId) || !nonBlank(expected.operationId)) return null;
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const candidate = evidence[index];
    if (!candidate || !nonBlank(candidate.evidenceRef)) continue;
    if (candidate.runId !== expected.runId) continue;
    if (candidate.sessionId !== expected.sessionId) continue;
    if (candidate.operationId !== expected.operationId) continue;
    return candidate;
  }
  return null;
}

export function applyVerifiedExecutionCompletion(
  context: ConversationOperatingContext,
  identity: RunExecutionIdentity,
  evidence: readonly RunExecutionEvidence[],
) {
  const verified = verifiedExecutionEvidence(evidence, identity);
  if (!verified) {
    return {
      verified: false as const,
      context,
      evidence: null,
    };
  }

  return {
    verified: true as const,
    context: {
      ...recordVerifiedFact(
        context,
        'The latest bound Lucy execution completed with verified result evidence.',
        verified.evidenceRef,
      ),
      blocker: null,
      nextAction: null,
    },
    evidence: verified,
  };
}
