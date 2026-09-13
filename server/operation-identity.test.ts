import { describe, expect, it } from 'vitest';
import { operationIdentity } from './collaboration-runner.js';

describe('provider operation identity namespace', () => {
  it('separates a direct send from retry/regenerate attempts that reuse the same caller key', () => {
    const sessionId = 'letta:conversation:[OpenClaw] Lucy';
    const direct = operationIdentity({
      idempotencyKey: 'same-key',
      userMessage: { id: 'user-message-1' },
    } as never, '[OpenClaw] Lucy', sessionId);
    const retry = operationIdentity({
      idempotencyKey: 'same-key',
      userMessage: { id: 'user-message-1' },
      regeneratedFromMessageId: 'assistant-message-1',
      retryMode: 'retry',
    } as never, '[OpenClaw] Lucy', sessionId);
    const regenerate = operationIdentity({
      idempotencyKey: 'same-key',
      userMessage: { id: 'user-message-1' },
      regeneratedFromMessageId: 'assistant-message-1',
      retryMode: 'regenerate',
    } as never, '[OpenClaw] Lucy', sessionId);

    expect(direct).toMatch(/caller-operation-sha256:[a-f0-9]{64}$/);
    expect(retry).toMatch(/caller-operation-sha256:[a-f0-9]{64}$/);
    expect(regenerate).toMatch(/caller-operation-sha256:[a-f0-9]{64}$/);
    expect(new Set([direct, retry, regenerate]).size).toBe(3);
  });

  it('keeps the same namespaced operation stable for an idempotent replay', () => {
    const input = {
      idempotencyKey: 'retry-key',
      userMessage: { id: 'user-message-1' },
      regeneratedFromMessageId: 'assistant-message-1',
      retryMode: 'retry',
    } as never;
    expect(operationIdentity(input, '[OpenClaw] Lucy', 'session-1')).toBe(
      operationIdentity(input, '[OpenClaw] Lucy', 'session-1'),
    );
  });
});
