import type { ConversationRecord } from '../shared/contracts.js';
import type { ConversationRuntimeIdentity } from '../shared/conversation-operating-context.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function boundedIdentifier(value: string, name: string, maxLength = 256) {
  const normalized = value.replace(CONTROL_CHARACTERS, '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must be a non-empty identifier no longer than ${maxLength} characters`);
  }
  return normalized;
}

function protocol(value: string | undefined) {
  return (value ?? '').trim().toLowerCase();
}

export function openClawConversationSessionIdentity(
  conversationId: string,
  sessionPrefix = process.env.LETTA_OPENCLAW_SESSION_PREFIX?.trim() || 'chat-v2',
) {
  const normalizedPrefix = boundedIdentifier(sessionPrefix, 'LETTA_OPENCLAW_SESSION_PREFIX', 64);
  const normalizedConversation = boundedIdentifier(conversationId, 'conversation id', 256);
  return `${normalizedPrefix}:${normalizedConversation}`;
}

/**
 * Return the exact stable identity the selected provider transport uses for
 * this logical conversation. The OpenClaw adapter sends this value explicitly
 * as `x-openclaw-session-key`; native/OpenAI adapters use session_id.
 */
export function providerSessionIdentity(
  conversation: ConversationRecord,
  agentId: string,
  requestedSessionId?: string,
) {
  if (conversation.systemId === 'letta' && protocol(process.env.LETTA_PROTOCOL) === 'openclaw') {
    return openClawConversationSessionIdentity(conversation.id);
  }

  const requested = requestedSessionId?.trim();
  return requested
    ? `${conversation.systemId}:${conversation.id}:${agentId}:caller-session:${requested}`
    : `${conversation.systemId}:${conversation.id}:${agentId}`;
}

export function conversationRuntimeIdentity(conversation: ConversationRecord): ConversationRuntimeIdentity {
  return {
    conversationId: conversation.id,
    backendSystem: conversation.systemId,
    agentId: conversation.agentId,
    sessionIdentity: providerSessionIdentity(conversation, conversation.agentId),
  };
}
