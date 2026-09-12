import type { AdapterExecutionReceipt, AdapterRequest } from './types.js';

export const EXECUTION_EVIDENCE_FRAME_TYPE = 'execution-evidence' as const;
export const EXECUTION_SESSION_HEADER = 'x-lucy-execution-session-id' as const;
export const EXECUTION_OPERATION_HEADER = 'x-lucy-execution-operation-id' as const;

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Correlation identities are transport metadata, never prompt prose. Backends
 * that can prove executable work may echo these exact values in a dedicated
 * execution-evidence frame after the operation finishes.
 */
export function executionCorrelationHeaders(request: AdapterRequest): Record<string, string> {
  if (!nonBlank(request.sessionId) || !nonBlank(request.idempotencyKey)) return {};
  return {
    [EXECUTION_SESSION_HEADER]: request.sessionId,
    [EXECUTION_OPERATION_HEADER]: request.idempotencyKey,
  };
}

/**
 * Parse only the explicit provider-owned receipt frame. Generic completion,
 * artifacts, tool-call text, response ids, and locally inferred success are
 * intentionally not accepted as execution evidence.
 */
export function extractExecutionReceipt(payload: unknown): AdapterExecutionReceipt | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const frame = payload as Record<string, unknown>;
  if (frame.type !== EXECUTION_EVIDENCE_FRAME_TYPE) return null;
  if (!frame.evidence || typeof frame.evidence !== 'object' || Array.isArray(frame.evidence)) {
    throw new Error('Execution evidence frame requires an evidence object');
  }
  const evidence = frame.evidence as Record<string, unknown>;
  const kind = evidence.kind;
  const sessionId = evidence.sessionId ?? evidence.session_id;
  const operationId = evidence.operationId ?? evidence.operation_id;
  const receiptId = evidence.receiptId ?? evidence.receipt_id;
  if (kind !== 'tool-receipt' && kind !== 'result-receipt') {
    throw new Error('Execution evidence frame kind is invalid');
  }
  if (!nonBlank(sessionId) || !nonBlank(operationId) || !nonBlank(receiptId)) {
    throw new Error('Execution evidence frame requires sessionId, operationId, and receiptId');
  }
  return {
    kind,
    sessionId: sessionId.trim(),
    operationId: operationId.trim(),
    receiptId: receiptId.trim(),
  };
}
