import type { AdapterExecutionReceipt, AdapterRequest } from './types.js';

export const EXECUTION_EVIDENCE_FRAME_TYPE = 'execution-evidence' as const;
export const EXECUTION_SESSION_HEADER = 'x-lucy-execution-session-id' as const;
export const EXECUTION_OPERATION_HEADER = 'x-lucy-execution-operation-id' as const;
const CORRELATION_ENCODING_PREFIX = 'v1.';

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalNonBlank(value: unknown): value is string {
  return nonBlank(value) && value === value.trim();
}

function encodeCorrelationIdentity(value: string) {
  return `${CORRELATION_ENCODING_PREFIX}${Buffer.from(value, 'utf8').toString('base64url')}`;
}

function decodeCorrelationIdentity(value: string) {
  if (value !== value.trim()) {
    throw new Error('Execution evidence correlation identity is noncanonical');
  }
  // Accept legacy/plain ASCII receipts during migration, but all headers emitted
  // by this client use the versioned UTF-8/base64url representation below.
  if (!value.startsWith(CORRELATION_ENCODING_PREFIX)) return value;
  const encoded = value.slice(CORRELATION_ENCODING_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Execution evidence correlation encoding is invalid');
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!decoded || encodeCorrelationIdentity(decoded) !== value) {
    throw new Error('Execution evidence correlation encoding is invalid');
  }
  return decoded;
}

/**
 * Correlation identities are transport metadata, never prompt prose. Header
 * values are versioned UTF-8/base64url so canonical identities containing
 * non-Latin agent names remain valid HTTP ByteStrings. A backend proving work
 * echoes these exact encoded header values in its execution-evidence frame;
 * the parser restores the logical identities before runner correlation.
 */
export function executionCorrelationHeaders(request: AdapterRequest): Record<string, string> {
  if (!nonBlank(request.sessionId) || !nonBlank(request.idempotencyKey)) return {};
  return {
    [EXECUTION_SESSION_HEADER]: encodeCorrelationIdentity(request.sessionId),
    [EXECUTION_OPERATION_HEADER]: encodeCorrelationIdentity(request.idempotencyKey),
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
  if (!canonicalNonBlank(sessionId) || !canonicalNonBlank(operationId) || !canonicalNonBlank(receiptId)) {
    throw new Error('Execution evidence frame requires canonical sessionId, operationId, and receiptId');
  }
  return {
    kind,
    sessionId: decodeCorrelationIdentity(sessionId),
    operationId: decodeCorrelationIdentity(operationId),
    // Receipt IDs are provider-owned opaque references. Never normalize them:
    // downstream validation either accepts the exact value or rejects it.
    receiptId,
  };
}
