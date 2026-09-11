import type { ConversationRecord } from '../shared/contracts.js';
import type { ConversationRuntimeIdentity } from '../shared/conversation-operating-context.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const LEGACY_PERSONAL_LUCY_PROVIDER_AGENT_ID = '[Letta] Lucy';
const OPENCLAW_PERSONAL_LUCY_AGENT_ID = '[OpenClaw] Lucy';

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

function openClawSessionAgentId(agentTarget: string | undefined) {
  const normalizedTarget = boundedIdentifier(
    agentTarget?.trim() || 'openclaw/main',
    'LETTA_OPENCLAW_AGENT_TARGET',
    256,
  );
  const agentId = normalizedTarget === 'openclaw'
    ? 'main'
    : normalizedTarget.startsWith('openclaw/')
      ? normalizedTarget.slice('openclaw/'.length)
      : normalizedTarget.startsWith('openclaw:')
        ? normalizedTarget.slice('openclaw:'.length)
        : normalizedTarget.startsWith('agent:')
          ? normalizedTarget.slice('agent:'.length)
          : '';
  return boundedIdentifier(agentId, 'OpenClaw session agent id', 128);
}

function stableProviderAgentId(conversation: ConversationRecord, agentId: string) {
  if (
    conversation.systemId === 'letta'
    && (agentId === LEGACY_PERSONAL_LUCY_PROVIDER_AGENT_ID || agentId === OPENCLAW_PERSONAL_LUCY_AGENT_ID)
  ) {
    // `[OpenClaw] Lucy` is the product identity rename of the existing personal
    // Lucy lane, not a new provider-side session namespace. Native/OpenAI-
    // compatible transports historically keyed this lane with `[Letta] Lucy`.
    // Keep that internal key stable so upgrading the UI identity does not split
    // an already-running backend conversation.
    return LEGACY_PERSONAL_LUCY_PROVIDER_AGENT_ID;
  }
  return agentId;
}

export function openClawConversationSessionIdentity(
  conversationId: string,
  sessionPrefix = process.env.LETTA_OPENCLAW_SESSION_PREFIX?.trim() || 'chat-v2',
  agentTarget = process.env.LETTA_OPENCLAW_AGENT_TARGET?.trim() || 'openclaw/main',
) {
  const normalizedPrefix = boundedIdentifier(sessionPrefix, 'LETTA_OPENCLAW_SESSION_PREFIX', 64);
  const normalizedConversation = boundedIdentifier(conversationId, 'conversation id', 256);
  return `agent:${openClawSessionAgentId(agentTarget)}:${normalizedPrefix}:${normalizedConversation}`;
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

  const providerAgentId = stableProviderAgentId(conversation, agentId);
  const requested = requestedSessionId?.trim();
  return requested
    ? `${conversation.systemId}:${conversation.id}:${providerAgentId}:caller-session:${requested}`
    : `${conversation.systemId}:${conversation.id}:${providerAgentId}`;
}

export function conversationRuntimeIdentity(conversation: ConversationRecord): ConversationRuntimeIdentity {
  return {
    conversationId: conversation.id,
    backendSystem: conversation.systemId,
    agentId: conversation.agentId,
    sessionIdentity: providerSessionIdentity(conversation, conversation.agentId),
  };
}
