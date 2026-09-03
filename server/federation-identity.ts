import type { ConversationRecord, FederationSnapshotRecord } from '../shared/contracts.js';

export const FEDERATED_CONVERSATION_IDENTITY_ERROR = 'FEDERATED_CONVERSATION_REQUIRES_HERMES_LUCY';

export function isFederationConversationIdentity(
  conversation: Pick<ConversationRecord, 'systemId' | 'agentId'>,
) {
  return conversation.systemId === 'hermes' && conversation.agentId === '[Hermes] Lucy';
}

export function federationSnapshotForConversation(
  conversation: Pick<ConversationRecord, 'systemId' | 'agentId'>,
  snapshot: FederationSnapshotRecord,
): FederationSnapshotRecord {
  return isFederationConversationIdentity(conversation)
    ? snapshot
    : { ...snapshot, config: null };
}
