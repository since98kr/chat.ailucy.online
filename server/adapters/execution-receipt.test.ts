import { describe, expect, it } from 'vitest';
import { executionCorrelationHeaders, extractExecutionReceipt } from './execution-receipt.js';

describe('provider execution receipt transport contract', () => {
  it('sends correlation identities only when both session and operation are present', () => {
    expect(executionCorrelationHeaders({ sessionId: 'session-1', idempotencyKey: 'operation-1' } as never)).toEqual({
      'x-lucy-execution-session-id': 'session-1',
      'x-lucy-execution-operation-id': 'operation-1',
    });
    expect(executionCorrelationHeaders({ sessionId: 'session-1' } as never)).toEqual({});
  });

  it('parses only an explicit execution-evidence frame', () => {
    expect(extractExecutionReceipt({
      type: 'execution-evidence',
      evidence: {
        kind: 'result-receipt',
        sessionId: 'session-1',
        operationId: 'operation-1',
        receiptId: 'provider-result-1',
      },
    })).toEqual({
      kind: 'result-receipt',
      sessionId: 'session-1',
      operationId: 'operation-1',
      receiptId: 'provider-result-1',
    });
    expect(extractExecutionReceipt({ type: 'artifact', id: 'not-evidence' })).toBeNull();
    expect(extractExecutionReceipt({ id: 'chatcmpl-provider-response' })).toBeNull();
  });

  it('supports snake-case provider fields but fails closed on malformed explicit receipt frames', () => {
    expect(extractExecutionReceipt({
      type: 'execution-evidence',
      evidence: {
        kind: 'tool-receipt',
        session_id: 'session-1',
        operation_id: 'operation-1',
        receipt_id: 'tool-result-1',
      },
    })).toMatchObject({ receiptId: 'tool-result-1' });
    expect(() => extractExecutionReceipt({
      type: 'execution-evidence',
      evidence: { kind: 'result-receipt', receiptId: 'missing-correlation' },
    })).toThrow('requires sessionId, operationId, and receiptId');
  });
});
