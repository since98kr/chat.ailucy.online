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
    expect(classifyPersonalMemoryOperation('내 생일을 장기 보관해줘')).toBe('remember');
    expect(classifyPersonalMemoryOperation('다음 대화에서도 이 생일을 보관해줘')).toBe('remember');
    expect(classifyPersonalMemoryOperation('다음 대화에서도 내 생일을 기억해줘')).toBe('remember');
    expect(classifyPersonalMemoryOperation('store my birthday for future conversations')).toBe('remember');
    expect(classifyPersonalMemoryOperation('Could you store my birthday for future conversations?')).toBe('remember');
    expect(classifyPersonalMemoryOperation('keep my birthday long-term')).toBe('remember');
    expect(classifyPersonalMemoryOperation('please remember my birthday')).toBe('remember');
    expect(classifyPersonalMemoryOperation('Could you remember my birthday for future conversations?')).toBe('remember');
    expect(classifyPersonalMemoryOperation('지난번에 내가 뭐라고 했는지 기억나?')).toBe('recall');
    expect(classifyPersonalMemoryOperation('내 생일 기억나?')).toBe('recall');
    expect(classifyPersonalMemoryOperation('what do you remember about my request?')).toBe('recall');
    expect(classifyPersonalMemoryOperation('recall my birthday')).toBe('recall');
    expect(classifyPersonalMemoryOperation('Could you recall my birthday?')).toBe('recall');
    expect(classifyPersonalMemoryOperation('이 기억 삭제해줘')).toBe('delete');
    expect(classifyPersonalMemoryOperation('이 기억을 삭제해줘')).toBe('delete');
    expect(classifyPersonalMemoryOperation('메모리를 삭제해줘')).toBe('delete');
    expect(classifyPersonalMemoryOperation('내 기억을 지워주세요')).toBe('delete');
    expect(classifyPersonalMemoryOperation('나에 대해 아는 모든 것을 삭제해줘')).toBe('delete');
    expect(classifyPersonalMemoryOperation('forget this')).toBe('delete');
    expect(classifyPersonalMemoryOperation('forget my birthday')).toBe('delete');
    expect(classifyPersonalMemoryOperation('delete what you remember about me')).toBe('delete');
    expect(classifyPersonalMemoryOperation('Could you delete what you remember about me?')).toBe('delete');
    expect(classifyPersonalMemoryOperation('delete my birthday from your memory')).toBe('delete');
    expect(classifyPersonalMemoryOperation('erase everything you know about me')).toBe('delete');
    expect(classifyPersonalMemoryOperation('이거 잊어줘')).toBe('delete');
    expect(classifyPersonalMemoryOperation('제발 이거 잊어줘')).toBe('delete');
    expect(classifyPersonalMemoryOperation('이제 이거 잊어줘')).toBe('delete');

    const ordinary = [
      'Memory Capsule 구조를 설명해줘',
      'AI memory architecture를 검토해줘',
      '사람들이 왜 약속을 잊어버리는지 설명해줘',
      '사람들은 새로운 단어를 어떻게 기억해?',
      '제 학생들이 단어를 어떻게 기억해?',
      '기억나는 영화 추천해줘',
      '어린 시절이 기억나는 이유를 설명해줘',
      '지난번 본 영화가 왜 기억나는지 설명해줘',
      '장기 프로젝트를 유지하는 방법을 설명해줘',
      '앞으로 프로젝트를 유지해줘',
      '경제 데이터를 장기 저장해줘',
      '메모리 누수 로그를 삭제해줘',
      'why do people forget appointments?',
      'keep this project long-term',
      'Please keep me on this project long-term',
      'Explain how delete releases memory in C++',
      'remove the memory leak from this code',
      'delete the memory leak',
      'Remember the Titans is a 2000 film; summarize it.',
      'delete my project',
      'remove my file',
      'recall the movie plot',
    ];
    for (const content of ordinary) expect(classifyPersonalMemoryOperation(content), content).toBeNull();
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

  it('blocks explicit remember/recall/delete before a mock or unverified backend can fabricate memory behavior', async () => {
    const calls: string[] = [];
    const wrapped = wrapPersonalMemoryBoundary(fakeAdapter(calls), {} as NodeJS.ProcessEnv);
    for (const content of [
      '이거 기억해 줘',
      '내 생일을 장기 보관해줘',
      '다음 대화에서도 내 생일을 기억해줘',
      'Could you remember my birthday for future conversations?',
      'Could you store my birthday for future conversations?',
      '지난번 기억나?',
      '내 생일 기억나?',
      'recall my birthday',
      'Could you recall my birthday?',
      '이 기억 삭제해줘',
      '이 기억을 삭제해줘',
      '메모리를 삭제해줘',
      '내 기억을 지워주세요',
      '나에 대해 아는 모든 것을 삭제해줘',
      '제발 이거 잊어줘',
      'delete what you remember about me',
      'Could you delete what you remember about me?',
      'delete my birthday from your memory',
      'erase everything you know about me',
    ]) {
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
    const ordinary = [
      '일반 대화 요청',
      '사람들이 왜 약속을 잊어버리는지 설명해줘',
      '사람들은 새로운 단어를 어떻게 기억해?',
      '제 학생들이 단어를 어떻게 기억해?',
      '기억나는 영화 추천해줘',
      '지난번 본 영화가 왜 기억나는지 설명해줘',
      '장기 프로젝트를 유지하는 방법을 설명해줘',
      '경제 데이터를 장기 저장해줘',
      '메모리 누수 로그를 삭제해줘',
      'Please keep me on this project long-term',
      'Explain how delete releases memory in C++',
      'remove the memory leak from this code',
      'delete the memory leak',
      'Remember the Titans is a 2000 film; summarize it.',
      'delete my project',
      'recall the movie plot',
    ];
    const outputs: AdapterStreamItem[] = [];
    for await (const item of wrapped.streamReply(request('이거 기억해 줘'))) outputs.push(item);
    for (const content of ordinary) {
      for await (const item of wrapped.streamReply(request(content))) outputs.push(item);
    }
    expect(calls).toEqual(['이거 기억해 줘', ...ordinary]);
    expect(outputs).toHaveLength(calls.length);
    expect(outputs.every((item) => item.type === 'delta' && item.delta === 'backend result')).toBe(true);
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
