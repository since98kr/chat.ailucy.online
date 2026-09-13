import type { ConversationRecord, SystemId } from '../shared/contracts.js';
import type { AdapterRequest, ChatBackendAdapter } from './adapters/types.js';

export type PersonalMemoryOperation = 'remember' | 'recall' | 'delete';

export type PersonalMemoryOwner = {
  systemId: 'letta';
  agentId: '[OpenClaw] Lucy';
  protocol: 'openclaw';
};

export type PersonalMemoryOwnerResolution =
  | { ok: true; operation: PersonalMemoryOperation; owner: PersonalMemoryOwner }
  | { ok: false; operation: PersonalMemoryOperation; reason: 'OWNER_UNAVAILABLE' | 'IDENTITY_MISMATCH' };

const CANONICAL_PERSONAL_MEMORY_AGENT = '[OpenClaw] Lucy' as const;

function normalized(value: string) {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function hasKoreanPersonalSignal(value: string) {
  return /(?:^|\s)(?:내|나의|제|저의)(?=\s|$)/u.test(value)
    || /(?:^|\s)나에\s+대(?:해|한)(?=\s|$)/u.test(value);
}

function hasKoreanCrossConversationSignal(value: string) {
  return /(?:다음\s*대화|다음에도|향후\s*대화|다른\s*대화에서도|대화가\s*바뀌어도)/u.test(value);
}

function isKoreanRememberRequest(value: string) {
  return /기억해\s*(?:줘|주세요|둬|두세요)(?:[.!?]*)$/u.test(value);
}

function isExplicitKoreanDurableSave(value: string) {
  const imperativeSave = /(?:보관|저장|남겨)(?:해\s*(?:줘|주세요)|해둬|해\s*둬|해주세요|해라)(?:[.!?]*)$/u;
  if (!imperativeSave.test(value)) return false;
  if (hasKoreanCrossConversationSignal(value)) return true;
  return hasKoreanPersonalSignal(value) && /(?:장기|앞으로)/u.test(value);
}

function isExplicitEnglishDurableSave(value: string) {
  if (!/^(?:please\s+)?(?:save|store|keep)\b/i.test(value)) return false;
  if (/\b(?:for\s+(?:future|later|next)\s+conversations?|across\s+conversations?)\b/i.test(value)) return true;
  return /\b(?:my|me|personal)\b/i.test(value) && /\blong[- ]term\b/i.test(value);
}

function isExplicitKoreanDelete(value: string) {
  if (/(?:기억|메모리).*(?:삭제해\s*(?:줘|주세요)|지워\s*(?:줘|주세요)|제거해\s*(?:줘|주세요))(?:[.!?]*)$/u.test(value)) {
    return true;
  }
  return /^(?:(?:제발|이제|그냥|앞으로|정말)\s+)*(?:이거|그거|이것|그것|방금(?:\s+말한\s+것)?|나에\s+대해|(?:내|제)\s+\S+(?:\s+\S+){0,4})\s*잊어\s*(?:줘|주세요)?[.!?]*$/u.test(value);
}

function isExplicitEnglishDelete(value: string) {
  if (/^(?:please\s+)?forget\s+(?:this|that|it|my\b.{0,80}|what\s+you\s+remember(?:ed)?\s+about\s+me\b.{0,40})[.!?]*$/i.test(value)) {
    return true;
  }
  return /^(?:please\s+)?(?:delete|remove|erase)\s+(?:(?:the\s+)?memories?\b.{0,80}|what\s+you\s+remember(?:ed)?\s+about\s+me\b.{0,40})[.!?]*$/i.test(value);
}

function isExplicitKoreanRemember(value: string) {
  if (/(?:장기기억|기억에).*(?:저장해\s*(?:줘|주세요)|남겨\s*(?:줘|주세요))(?:[.!?]*)$/u.test(value)) return true;

  // Cross-conversation persistence is explicit even when it prefixes the
  // personal fact: "다음 대화에서도 내 생일을 기억해줘".
  if (hasKoreanCrossConversationSignal(value) && isKoreanRememberRequest(value)) return true;

  // Broad personal noun phrases require an unmistakable request suffix. This
  // keeps explanatory questions such as "제 학생들이 ... 어떻게 기억해?"
  // outside the persistence boundary.
  if (
    /^(?:(?:제발|앞으로|이제)\s+)*(?:(?:내|제)\s+.+|나에\s+대한\s+.+)\s+기억해\s*(?:줘|주세요|둬|두세요)[.!?]*$/u.test(value)
  ) return true;

  // Deictic targets can safely accept the short imperative form when it is not
  // phrased as a question.
  return /^(?:(?:제발|앞으로|이제)\s+)*(?:이거|그거|이것|그것|방금(?:\s+말한\s+것)?)\s+기억해(?:\s*(?:줘|주세요|둬|두세요))?[.!]*$/u.test(value);
}

function isExplicitEnglishRemember(value: string) {
  return /^(?:please\s+)?remember\s+(?:this|that|it|my\b.{0,120}|what\s+i\s+(?:said|asked|told)\b.{0,80})[.!?]*$/i.test(value)
    || /^(?:please\s+)?(?:save|store)\s+(?:this|that|it|my\b.{0,120})\s+(?:in|to)\s+(?:your\s+)?memor(?:y|ies)[.!?]*$/i.test(value);
}

function isExplicitKoreanRecall(value: string) {
  if (/(?:지난번|전에|지난\s*대화|이전\s*대화|우리(?:가)?\s+전에).*(?:기억나|기억하고\s+있어|기억해\s*\?)/u.test(value)) return true;
  if (/(?:내가|나에\s+대해|내\s+\S+(?:\s+\S+){0,4}).*(?:뭐|무엇|어떤).*(?:기억|기억나)/u.test(value)) return true;
  return false;
}

function isExplicitEnglishRecall(value: string) {
  return /^what\s+do\s+you\s+remember\s+about\s+(?:me|my\b.{0,100}|our\b.{0,100}|the\s+(?:last|previous|earlier)\b.{0,80})[?!.]*$/i.test(value)
    || /^do\s+you\s+remember\s+(?:me|my\b.{0,100}|what\s+i\s+(?:said|asked|told)\b.{0,80}|our\s+(?:last|previous|earlier)\b.{0,80})[?!.]*$/i.test(value)
    || /^(?:please\s+)?recall\s+(?:my\b.{0,100}|what\s+i\s+(?:said|asked|told)\b.{0,80}|what\s+you\s+remember(?:ed)?\s+about\s+me\b.{0,60}|our\s+(?:last|previous|earlier)\b.{0,80})[?!.]*$/i.test(value);
}

/**
 * Recognize only explicit personal-memory operations. Generic discussion of
 * "memory" or the product's Memory Capsules is ordinary chat, not authority to
 * persist, recall, or delete native personal memory.
 */
export function classifyPersonalMemoryOperation(content: string): PersonalMemoryOperation | null {
  const value = normalized(content);
  if (!value) return null;

  if (isExplicitKoreanDelete(value) || isExplicitEnglishDelete(value)) return 'delete';

  if (
    isExplicitKoreanRemember(value)
    || isExplicitKoreanDurableSave(value)
    || isExplicitEnglishRemember(value)
    || isExplicitEnglishDurableSave(value)
  ) return 'remember';

  if (isExplicitKoreanRecall(value) || isExplicitEnglishRecall(value)) return 'recall';

  return null;
}

export function resolvePersonalMemoryOwner(
  conversation: Pick<ConversationRecord, 'systemId' | 'agentId'>,
  operation: PersonalMemoryOperation,
  env: NodeJS.ProcessEnv = process.env,
): PersonalMemoryOwnerResolution {
  // A Memory Capsule is not native personal memory. The only source-level owner
  // we can identify today is the canonical personal Lucy when the real OpenClaw
  // transport is explicitly configured. HTTP/mock/unavailable routes do not
  // prove durable remember/recall/delete capability and therefore fail closed.
  if ((env.LETTA_PROTOCOL ?? '').trim().toLowerCase() !== 'openclaw') {
    return { ok: false, operation, reason: 'OWNER_UNAVAILABLE' };
  }
  if (conversation.systemId !== 'letta' || conversation.agentId !== CANONICAL_PERSONAL_MEMORY_AGENT) {
    return { ok: false, operation, reason: 'IDENTITY_MISMATCH' };
  }
  return {
    ok: true,
    operation,
    owner: {
      systemId: 'letta',
      agentId: CANONICAL_PERSONAL_MEMORY_AGENT,
      protocol: 'openclaw',
    },
  };
}

export const PERSONAL_MEMORY_UNKNOWN_MESSAGE =
  'UNKNOWN: 현재 Conversation에는 검증된 native personal-memory owner가 연결되어 있지 않아 기억 저장·회상·삭제를 확인하거나 수행하지 않았습니다. Memory Capsule은 별도의 명시적 교차 시스템 문맥이며 native personal memory의 증거가 아닙니다.';

/**
 * Adapter boundary: explicit memory operations may reach only the verified
 * canonical personal-memory owner. Unsupported/mock routes fail before calling
 * the inner adapter, so they cannot fabricate persistence, recall, or deletion.
 */
export function wrapPersonalMemoryBoundary(
  adapter: ChatBackendAdapter,
  env: NodeJS.ProcessEnv = process.env,
): ChatBackendAdapter {
  return {
    systemId: adapter.systemId,
    health: () => adapter.health(),
    async *streamReply(request: AdapterRequest) {
      const operation = classifyPersonalMemoryOperation(request.userMessage.content);
      if (operation) {
        const resolution = resolvePersonalMemoryOwner(request.conversation, operation, env);
        if (!resolution.ok) throw new Error(PERSONAL_MEMORY_UNKNOWN_MESSAGE);
      }
      yield* adapter.streamReply(request);
    },
  };
}

export function nativeMemoryOwnerSystemId(owner: PersonalMemoryOwner): SystemId {
  return owner.systemId;
}
