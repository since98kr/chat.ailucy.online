import type { AdapterRequest, AdapterStreamItem, ChatBackendAdapter } from './types.js';
import type { AdapterHealthRecord, SystemId } from '../../shared/contracts.js';

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function hermesReply(request: AdapterRequest) {
  const latest = request.userMessage.content.slice(0, 100);
  if (request.targetAgentId === 'Xixi') {
    return `Xixi 원문 결과: “${latest}” 요청을 구현 관점에서 분해했습니다. 데이터 모델, API 계약, 실패 복구, 테스트 가능한 경계를 우선해 실행안을 작성합니다.`;
  }
  if (request.targetAgentId === 'Lynn') {
    return `Lynn 독립 검토 원문: “${latest}”에 대해 전제 누락, 충돌 가능성, 검증되지 않은 주장, 되돌리기 어려운 변경을 우선적으로 점검했습니다.`;
  }
  if (request.targetAgentId === 'Gemma') {
    return `Gemma 원문 결과: “${latest}”와 연결된 이미지·영상·문서 증거가 있다면 구조, 시각정보, 누락된 맥락을 멀티모달 관점에서 분석합니다.`;
  }
  if (request.routingMode === 'team') {
    const contributors = request.participants
      .filter((participant) => participant.agentId !== request.targetAgentId && participant.state !== 'offline')
      .map((participant) => participant.agent.displayName)
      .join(', ');
    return `[Hermes] Lucy 종합응답: ${contributors || '선택된 subagent'}의 원문 결과를 보존한 상태에서 “${latest}”에 대한 결론과 다음 행동을 통합합니다. 서로 다른 의견은 지우지 않고 차이점과 판단 근거를 함께 제시합니다.`;
  }
  return `Tei님, [Hermes] Lucy가 이 Conversation의 책임자로 “${latest}”를 직접 처리합니다. 필요한 에이전트는 명시적 멘션이나 참여자 설정으로만 호출됩니다.`;
}

function buildReply(systemId: SystemId, request: AdapterRequest) {
  const latest = request.userMessage.content;
  if (systemId === 'letta') {
    return `Tei님, 이 Conversation은 다른 아젠다와 분리해서 유지하겠습니다. 다만 [Letta] Lucy의 승인된 장기기억은 이어집니다. 방금 요청하신 “${latest.slice(0, 80)}”를 현재 Conversation의 중심 아젠다로 잡았습니다.`;
  }
  return hermesReply(request);
}

export class MockAdapter implements ChatBackendAdapter {
  constructor(readonly systemId: SystemId) {}

  async health(): Promise<AdapterHealthRecord> {
    return { ok: true, mode: 'mock', detail: `${this.systemId} mock adapter ready` };
  }

  async *streamReply(request: AdapterRequest): AsyncGenerator<AdapterStreamItem> {
    const status = this.systemId === 'letta'
      ? '기억을 확인하는 중'
      : request.targetAgentId === '[Hermes] Lucy'
        ? request.routingMode === 'team' ? '팀 결과를 종합하는 중' : '요청을 분석하는 중'
        : `${request.targetAgentId} 작업 중`;
    yield { type: 'status', status };
    await sleep(90);

    const reply = buildReply(this.systemId, request);
    const chunks = reply.match(/.{1,10}/gu) ?? [reply];
    for (const delta of chunks) {
      if (request.signal?.aborted) return;
      yield { type: 'delta', delta };
      await sleep(18);
    }
  }
}
