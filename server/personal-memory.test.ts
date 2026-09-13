import { describe, expect, it } from 'vitest';
import type { AdapterRequest, AdapterStreamItem, ChatBackendAdapter } from './adapters/types.js';
import {
  PERSONAL_MEMORY_UNKNOWN_MESSAGE,
  classifyPersonalMemoryOperation,
  resolvePersonalMemoryOwner,
  wrapPersonalMemoryBoundary,
} from './personal-memory.js';

function request(content: string, systemId: 'letta' | 'hermes' = 'letta', agentId = '[OpenClaw] Lucy') {
  return {
    conversation: { systemId, agentId },
    userMessage: { content },
  } as AdapterRequest;
}

function fakeAdapter(calls: string[]): ChatBackendAdapter {
  return {
    systemId: 'letta',
    async health() { return { ok: true, mode: 'mock', detail: 'memory owner fixture' }; },
    async *streamReply(input) {
      calls.push(input.userMessage.content);
      yield { type: 'delta', delta: 'backend result' } satisfies AdapterStreamItem;
    },
  };
}

describe('personal memory owner contract', () => {
  it('classifies explicit remember, recall, and delete requests without treating generic memory discussion as an operation', () => {
    expect(classifyPersonalMemoryOperation('이건 장기기억에 저장해줘')).toBe('remember');
    expect(classifyPersonalMemoryOperation('이거 기억해 줘')).toBe('remember');
    expect(classifyPersonalMemoryOperation('지난번에 내가 뭐라고 했는지 기억나?')).toBe('recall');
    expect(classifyPersonalMemoryOperation('what do you remember about my request?')).toBe('recall');
    expect(classifyPersonalMemoryOperation('이 기억 삭제해줘')).toBe('delete');
    expect(classifyPersonalMemoryOperation('forget this')).toBe('delete');
    expect(classifyPersonalMemoryOperation('Memory Capsule 구조를 설명해줘')).toBeNull();
    expect(classifyPersonalMemoryOperation('AI memory architecture를 검토해줘')).toBeNull();
  });

  it('resolves only canonical OpenClaw Lucy on the explicitly configured OpenClaw transport as the native owner', () => {
    const env = { LETTA_PROTOCOL: 'openclaw' } as NodeJS.ProcessEnv;
    expect(resolvePersonalMemoryOwner(
      { systemId: 'letta', agentId: '[OpenClaw] Lucy' } as never,
      'recall',
      env,
    )).toEqual({
      ok: true,
      operation: 'recall',
      owner: { systemId: 'letta', agentId: '[OpenClaw] Lucy', protocol: 'openclaw' },
    });
    expect(resolvePersonalMemoryOwner(
      { systemId: 'hermes', agentId: '[Hermes] Lucy' } as never,
      'remember',
      env,
    )).toEqual({ ok: false, operation: 'remember', reason: 'IDENTITY_MISMATCH' });
    expect(resolvePersonalMemoryOwner(
      { systemId: 'letta', agentId: '[OpenClaw] Lucy' } as never,
      'delete',
      {} as NodeJS.ProcessEnv,
    )).toEqual({ ok: false, operation: 'delete', reason: 'OWNER_UNAVAILABLE' });
  });

  it('blocks remember/recall/delete before a mock or unverified backend can fabricate memory behavior', async () => {
    const calls: string[] = [];
    const wrapped = wrapPersonalMemoryBoundary(fakeAdapter(calls), {} as NodeJS.ProcessEnv);
    for (const content of ['이거 기억해 줘', '지난번 기억나?', '이 기억 삭제해줘']) {
      const consume = async () => {
        for await (const _item of wrapped.streamReply(request(content))) {
          // no-op
        }
      };
      await expect(consume()).rejects.toThrow(PERSONAL_MEMORY_UNKNOWN_MESSAGE);
    }
    expect(calls).toEqual([]);
  });

  it('routes explicit memory requests to the verified canonical owner and keeps ordinary chat unchanged', async () => {
    const calls: string[] = [];
    const wrapped = wrapPersonalMemoryBoundary(fakeAdapter(calls), { LETTA_PROTOCOL: 'openclaw' } as NodeJS.ProcessEnv);
    const outputs: AdapterStreamItem[] = [];
    for await (const item of wrapped.streamReply(request('이거 기억해 줘'))) outputs.push(item);
    for await (const item of wrapped.streamReply(request('일반 대화 요청'))) outputs.push(item);
    expect(calls).toEqual(['이거 기억해 줘', '일반 대화 요청']);
    expect(outputs).toEqual([
      { type: 'delta', delta: 'backend result' },
      { type: 'delta', delta: 'backend result' },
    ]);
  });

  it('keeps Memory Capsule language outside native personal-memory operations', async () => {
    const calls: string[] = [];
    const wrapped = wrapPersonalMemoryBoundary(fakeAdapter(calls), {} as NodeJS.ProcessEnv);
    for await (const _item of wrapped.streamReply(request('Memory Capsule 승인 상태를 보여줘'))) {
      // pass through ordinary chat
    }
    expect(calls).toEqual(['Memory Capsule 승인 상태를 보여줘']);
  });
});
