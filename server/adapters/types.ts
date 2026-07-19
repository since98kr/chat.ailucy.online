import type {
  AdapterHealthRecord,
  AgentRecord,
  ArtifactRecord,
  ConversationParticipantRecord,
  ConversationRecord,
  MemoryCapsuleRecord,
  MessageRecord,
  RoutingMode,
  SystemId,
} from '../../shared/contracts.js';

export type AdapterGeneratedArtifact = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};

export type AdapterStreamItem =
  | { type: 'status'; status: string }
  | { type: 'delta'; delta: string }
  | { type: 'artifact'; artifact: AdapterGeneratedArtifact };

export interface AdapterRequest {
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  history: MessageRecord[];
  artifacts?: ArtifactRecord[];
  targetAgentId: string;
  routingMode: RoutingMode;
  participants: ConversationParticipantRecord[];
  federatedAgents?: AgentRecord[];
  memoryCapsules?: MemoryCapsuleRecord[];
  workflowRunId?: string;
  signal?: AbortSignal;
}

export interface ChatBackendAdapter {
  readonly systemId: SystemId;
  health(): Promise<AdapterHealthRecord>;
  streamReply(request: AdapterRequest): AsyncGenerator<AdapterStreamItem>;
}
