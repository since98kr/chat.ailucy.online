import { describe, expect, it } from 'vitest';
import { executionCorrelationHeaders, extractExecutionReceipt } from './execution-receipt.js';

describe('provider execution receipt transport contract', () => {
  it('sends versioned ASCII-safe correlation identities only when both values are present', () => {
    const headers = executionCorrelationHeaders({
      sessionId: 'letta:conversation:[Claude] 테이아',
      idempotencyKey: '작업-재시도-1',
    } as never);
    expect(headers['x-lucy-execution-session-id']).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(headers['x-lucy-execution-operation-id']).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(headers['x-lucy-execution-session-id']).not.toContain('테이아');
    expect(headers['x-lucy-execution-operation-id']).not.toContain('작업');
    expect(executionCorrelationHeaders({ sessionId: 'session-1' } as never)).toEqual({});
  });

  it('restores encoded provider-echoed identities before returning explicit execution evidence', () => {
    const headers = executionCorrelationHeaders({
      sessionId: 'letta:conversation:[Claude] 테이아',
      idempotencyKey: 'operation-한글',
    } as never);
    expect(extractExecutionReceipt({
      type: 'execution-evidence',
      evidence: {
        kind: 'result-receipt',
        sessionId: headers['x-lucy-execution-session-id'],
        operationId: headers['x-lucy-execution-operation-id'],
        receiptId: 'provider-result-1',
      },
    })).toEqual({
      kind: 'result-receipt',
      sessionId: 'letta:conversation:[Claude] 테이아',
      operationId: 'operation-한글',
      receiptId: 'provider-result-1',
    });
    expect(extractExecutionReceipt({ type: 'artifact', id: 'not-evidence' })).toBeNull();
    expect(extractExecutionReceipt({ id: 'chatcmpl-provider-response' })).toBeNull();
  });

  it('supports legacy/plain and snake-case provider fields but fails closed on malformed explicit frames', () => {
    expect(extractExecutionReceipt({
      type: 'execution-evidence',
      evidence: {
        kind: 'tool-receipt',
        session_id: 'session-1',
        operation_id: 'operation-1',
        receipt_id: 'tool-result-1',
      },
    })).toEqual({
      kind: 'tool-receipt',
      sessionId: 'session-1',
      operationId: 'operation-1',
      receiptId: 'tool-result-1',
    });
    expect(() => extractExecutionReceipt({
      type: 'execution-evidence',
      evidence: { kind: 'result-receipt', receiptId: 'missing-correlation' },
    })).toThrow('requires sessionId, operationId, and receiptId');
    expect(() => extractExecutionReceipt({
      type: 'execution-evidence',
      evidence: {
        kind: 'result-receipt',
        sessionId: 'v1.***',
        operationId: 'operation-1',
        receiptId: 'bad-encoding',
      },
    })).toThrow('correlation encoding is invalid');
  });
});
