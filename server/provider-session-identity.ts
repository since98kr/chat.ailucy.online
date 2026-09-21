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

function openClawEnv(canonical: string, legacy: string) {
  return process.env[canonical]?.trim() || process.env[legacy]?.trim() || undefined;
}

function openClawSessionAgentId(agentTarget: string | undefined) {
  const normalizedTarget = boundedIdentifier(
    agentTarget?.trim() || 'openclaw/main',
    'OPENCLAW_AGENT_TARGET',
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
    conversation.systemId === 'openclaw'
    && (agentId === LEGACY_PERSONAL_LUCY_PROVIDER_AGENT_ID || agentId === OPENCLAW_PERSONAL_LUCY_AGENT_ID)
  ) {
    // The legacy provider-side key remains only to preserve existing session
    // continuity while product/runtime identity is canonically OpenClaw.
    return LEGACY_PERSONAL_LUCY_PROVIDER_AGENT_ID;
  }
  return agentId;
}

export function openClawConversationSessionIdentity(
  conversationId: string,
  sessionPrefix = openClawEnv('OPENCLAW_SESSION_PREFIX', 'LETTA_OPENCLAW_SESSION_PREFIX') || 'chat-v2',
  agentTarget = openClawEnv('OPENCLAW_AGENT_TARGET', 'LETTA_OPENCLAW_AGENT_TARGET') || 'openclaw/main',
) {
  const normalizedPrefix = boundedIdentifier(sessionPrefix, 'OPENCLAW_SESSION_PREFIX', 64);
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
  const openClawProtocol = protocol(process.env.OPENCLAW_PROTOCOL ?? process.env.LETTA_PROTOCOL);
  if (conversation.systemId === 'openclaw' && openClawProtocol === 'openclaw') {
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
