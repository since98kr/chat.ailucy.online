import type { AdapterRequest, AdapterStreamItem, ChatBackendAdapter } from './types.js';
import type { AdapterHealthRecord, SystemId } from '../../shared/contracts.js';

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function buildReply(systemId: SystemId, request: AdapterRequest) {
  const latest = request.userMessage.content;
  if (systemId === 'letta') {
    return `Tei님, 이 Conversation은 다른 아젠다와 분리해서 유지하겠습니다. 다만 [Letta] Lucy의 승인된 장기기억은 이어집니다. 방금 요청하신 “${latest.slice(0, 80)}”를 현재 Conversation의 중심 아젠다로 잡았습니다.`;
  }

  return `Tei님, [Hermes] Lucy가 이 Conversation의 책임자로 응답합니다. 요청하신 “${latest.slice(0, 80)}”를 기준으로 직접 처리하고, 필요한 경우에만 Xixi·Lynn·Gemma를 선택적으로 참여시키겠습니다. 고정된 역할 파이프라인은 강제하지 않습니다.`;
}

export class MockAdapter implements ChatBackendAdapter {
  constructor(readonly systemId: SystemId) {}

  async health(): Promise<AdapterHealthRecord> {
    return { ok: true, mode: 'mock', detail: `${this.systemId} mock adapter ready` };
  }

  async *streamReply(request: AdapterRequest): AsyncGenerator<AdapterStreamItem> {
    yield { type: 'status', status: this.systemId === 'letta' ? '기억을 확인하는 중' : '요청을 분석하는 중' };
    await sleep(120);

    const reply = buildReply(this.systemId, request);
    const chunks = reply.match(/.{1,10}/gu) ?? [reply];

    for (const delta of chunks) {
      if (request.signal?.aborted) return;
      yield { type: 'delta', delta };
      await sleep(24);
    }
  }
}
