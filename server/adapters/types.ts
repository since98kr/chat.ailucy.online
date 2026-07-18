import type {
  AdapterHealthRecord,
  ConversationParticipantRecord,
  ConversationRecord,
  MessageRecord,
  RoutingMode,
  SystemId,
} from '../../shared/contracts.js';

export type AdapterStreamItem =
  | { type: 'status'; status: string }
  | { type: 'delta'; delta: string };

export interface AdapterRequest {
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  history: MessageRecord[];
  targetAgentId: string;
  routingMode: RoutingMode;
  participants: ConversationParticipantRecord[];
  signal?: AbortSignal;
}

export interface ChatBackendAdapter {
  readonly systemId: SystemId;
  health(): Promise<AdapterHealthRecord>;
  streamReply(request: AdapterRequest): AsyncGenerator<AdapterStreamItem>;
}
