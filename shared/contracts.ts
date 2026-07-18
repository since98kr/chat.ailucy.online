export type SystemId = 'letta' | 'hermes';
export type ConversationStatus = 'active' | 'archived' | 'trashed';
export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageState = 'complete' | 'streaming' | 'failed' | 'cancelled';

export interface ConversationRecord {
  id: string;
  systemId: SystemId;
  agentId: string;
  title: string;
  preview: string;
  status: ConversationStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastReadMessageId: string | null;
  draft: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  authorId: string;
  content: string;
  state: MessageState;
  parentMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  conversationId: string;
  messageId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: string;
}

export interface ConversationDetail extends ConversationRecord {
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
}

export type StreamEvent =
  | { type: 'message.accepted'; message: MessageRecord }
  | { type: 'run.started'; runId: string }
  | { type: 'run.status'; runId: string; status: string }
  | { type: 'content.delta'; runId: string; messageId: string; delta: string }
  | { type: 'artifact.created'; runId: string; artifact: ArtifactRecord }
  | { type: 'run.completed'; runId: string; message: MessageRecord }
  | { type: 'run.failed'; runId: string; error: string };

export interface CreateConversationInput {
  systemId: SystemId;
  agentId: string;
  title?: string;
}

export interface UpdateConversationInput {
  title?: string;
  pinned?: boolean;
  status?: ConversationStatus;
  draft?: string;
  lastReadMessageId?: string | null;
}

export interface SendMessageInput {
  content: string;
  clientMessageId?: string;
  parentMessageId?: string | null;
}
