import {
  recordVerifiedFact,
  type ConversationOperatingContext,
} from '../shared/conversation-operating-context.js';
import type { AdapterExecutionReceipt } from './adapters/types.js';

export type RunExecutionIdentity = {
  runId: string;
  sessionId: string;
  operationId: string;
};

export type RunExecutionEvidence = RunExecutionIdentity & {
  kind: AdapterExecutionReceipt['kind'];
  evidenceRef: string;
};

const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function nonBlank(value: string) {
  return value.trim().length > 0;
}

/**
 * Convert a provider-owned receipt into current-run evidence only after the
 * provider echoes the exact session + operation identity. The current runId is
 * attached after that verification; generic artifacts or locally inferred
 * success never create execution evidence.
 */
export function providerExecutionEvidence(
  identity: RunExecutionIdentity,
  receipt: AdapterExecutionReceipt,
): RunExecutionEvidence | null {
  if (!nonBlank(identity.runId) || !nonBlank(identity.sessionId) || !nonBlank(identity.operationId)) return null;
  if (receipt.sessionId !== identity.sessionId) return null;
  if (receipt.operationId !== identity.operationId) return null;
  if (!SAFE_RECEIPT_ID.test(receipt.receiptId)) return null;
  return {
    ...identity,
    kind: receipt.kind,
    evidenceRef: `provider-receipt:${receipt.receiptId}`,
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
        'The latest bound Lucy execution completed with verified provider result evidence.',
        verified.evidenceRef,
      ),
      blocker: null,
      nextAction: null,
    },
    evidence: verified,
  };
}
