import { describe, expect, it } from 'vitest';
import type { AdapterRequest, ChatBackendAdapter } from './adapters/types.js';
import {
  PERSONAL_MEMORY_UNKNOWN_MESSAGE,
  classifyPersonalMemoryOperation,
  wrapPersonalMemoryBoundary,
} from './personal-memory.js';

function unverifiedRequest(content: string) {
  return {
    conversation: { systemId: 'letta', agentId: '[OpenClaw] Lucy' },
    userMessage: { content },
  } as AdapterRequest;
}

function fakeAdapter(calls: string[]): ChatBackendAdapter {
  return {
    systemId: 'letta',
    async health() { return { ok: true, mode: 'mock', detail: 'polite modal fixture' }; },
    async *streamReply(request) {
      calls.push(request.userMessage.content);
      yield { type: 'delta', delta: 'unexpected backend call' } as const;
    },
  };
}

describe('personal-memory polite modal prefix ordering', () => {
  it('classifies please-before-modal remember, recall, and delete requests', () => {
    expect(classifyPersonalMemoryOperation('Please could you remember my birthday?')).toBe('remember');
    expect(classifyPersonalMemoryOperation('Please would you recall my birthday?')).toBe('recall');
    expect(classifyPersonalMemoryOperation('Please can you delete what you remember about me?')).toBe('delete');
    expect(classifyPersonalMemoryOperation('Please will you forget everything you know about me?')).toBe('delete');
  });

  it('fails closed before an unverified owner can handle those operations', async () => {
    const calls: string[] = [];
    const wrapped = wrapPersonalMemoryBoundary(fakeAdapter(calls), {} as NodeJS.ProcessEnv);
    const requests = [
      'Please could you remember my birthday?',
      'Please would you recall my birthday?',
      'Please can you delete what you remember about me?',
    ];

    for (const content of requests) {
      const consume = async () => {
        for await (const _item of wrapped.streamReply(unverifiedRequest(content))) {
          // no-op
        }
      };
      await expect(consume()).rejects.toThrow(PERSONAL_MEMORY_UNKNOWN_MESSAGE);
    }
    expect(calls).toEqual([]);
  });

  it('keeps ordinary polite modal discussion outside personal memory', () => {
    expect(classifyPersonalMemoryOperation('Please could you explain why people forget appointments?')).toBeNull();
    expect(classifyPersonalMemoryOperation('Please could you help me fix a memory leak?')).toBeNull();
  });
});
