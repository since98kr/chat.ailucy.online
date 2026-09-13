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

/**
 * Recognize only explicit personal-memory operations. Generic discussion of
 * "memory" or the product's Memory Capsules is ordinary chat, not authority to
 * persist, recall, or delete native personal memory.
 */
export function classifyPersonalMemoryOperation(content: string): PersonalMemoryOperation | null {
  const value = normalized(content);
  if (!value) return null;

  if (
    /(?:기억|메모리).*(?:삭제|지워|지우|제거)/u.test(value)
    || /^(?:이거|그거|이것|그것|방금(?:\s+말한\s+것)?|나에\s+대해|내\s+\S+(?:\s+\S+){0,4})?\s*잊어\s*(?:줘|주세요)?[.!?]*$/u.test(value)
    || /\b(?:forget|delete|remove|erase)\b.*\b(?:memory|memories|remembered)\b/i.test(value)
    || /\bforget\b\s+(?:this|that|it|my\s+\S+(?:\s+\S+){0,4})\b/i.test(value)
  ) return 'delete';

  if (
    /(?:기억해\s*(?:줘|둬|두|주세요)?|기억해두|기억해 둬|기억해 줘|장기기억.*(?:저장|기억)|기억에.*(?:저장|남겨))/u.test(value)
    || /(?:장기|앞으로|다음\s*대화|다음에도|향후\s*대화).*(?:보관|저장|남겨|유지)/u.test(value)
    || /\bremember\b\s+(?:this|that|it|my|the)\b/i.test(value)
    || /\b(?:save|store)\b.*\b(?:memory|remember)\b/i.test(value)
    || /\b(?:save|store|keep)\b.*\b(?:for\s+(?:future|later|next)\s+conversations?|across\s+conversations?|long[- ]term)\b/i.test(value)
  ) return 'remember';

  if (
    /(?:뭐|무엇|어떤|내가|전에|지난번).*(?:기억|기억나)/u.test(value)
    || /(?:기억나|기억하고 있어|기억해\s*\?)/u.test(value)
    || /\b(?:recall|what do you remember|do you remember)\b/i.test(value)
  ) return 'recall';

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
