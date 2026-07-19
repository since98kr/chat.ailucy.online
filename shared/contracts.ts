export type SystemId = 'letta' | 'hermes';
export type ConversationStatus = 'active' | 'archived' | 'trashed';
export type ConversationMode = 'single' | 'federated';
export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageState = 'complete' | 'streaming' | 'failed' | 'cancelled';
export type ParticipantRole = 'lead' | 'participant' | 'observer';
export type ParticipantState = 'active' | 'idle' | 'working' | 'reviewing' | 'blocked' | 'offline';
export type TeamActivityType = 'joined' | 'left' | 'assigned' | 'status' | 'output' | 'completed' | 'failed';
export type RoutingMode = 'direct' | 'lead' | 'team';
export type MemoryCapsuleStatus = 'draft' | 'approved' | 'revoked';
export type ArtifactDeliveryState = 'delivering' | 'delivered' | 'unsupported' | 'failed';
export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
export type WorkflowEventType =
  | 'run.created'
  | 'run.started'
  | 'run.paused'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'step.started'
  | 'step.status'
  | 'step.delta'
  | 'step.completed'
  | 'step.failed'
  | 'capsule.used'
  | 'replay.started';

export interface AgentRecord {
  id: string;
  systemId: SystemId;
  displayName: string;
  shortName: string;
  role: string;
  description: string;
  capabilities: string[];
  enabled: boolean;
  directChatEnabled: boolean;
  isLead: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationParticipantRecord {
  conversationId: string;
  agentId: string;
  role: ParticipantRole;
  state: ParticipantState;
  addedAt: string;
  updatedAt: string;
  agent: AgentRecord;
}

export interface TeamActivityRecord {
  id: string;
  conversationId: string;
  agentId: string;
  type: TeamActivityType;
  status: ParticipantState;
  summary: string;
  sourceMessageId: string | null;
  outputMessageId: string | null;
  createdAt: string;
  agent: AgentRecord;
}

export interface RoutingPlanRecord {
  mode: RoutingMode;
  leadAgentId: string;
  mentionedAgentIds: string[];
  targetAgentIds: string[];
  rejectedMentions: string[];
}

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
  branchedFromConversationId: string | null;
  branchedFromMessageId: string | null;
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

export interface ArtifactDeliveryRecord {
  runId: string;
  messageId: string;
  agentId: string;
  systemId: SystemId;
  artifactIds: string[];
  state: ArtifactDeliveryState;
  detail: string | null;
}

export interface ConversationDetail extends ConversationRecord {
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
}

export interface ConversationSearchResult {
  conversation: ConversationRecord;
  snippet: string;
  matchedIn: 'title' | 'message' | 'artifact';
  messageId: string | null;
}

export interface AdapterHealthRecord {
  ok: boolean;
  mode: 'mock' | 'http';
  detail: string;
  latencyMs?: number;
}

export interface FederationConfigRecord {
  conversationId: string;
  mode: ConversationMode;
  coordinatorAgentId: string;
  allowedSystemIds: SystemId[];
  memoryPolicy: 'explicit-capsules-only';
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCapsuleRecord {
  id: string;
  conversationId: string;
  sourceSystemId: SystemId;
  targetSystemId: SystemId;
  title: string;
  content: string;
  status: MemoryCapsuleStatus;
  sourceMessageIds: string[];
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepRecord {
  id: string;
  runId: string;
  agentId: string;
  systemId: SystemId;
  position: number;
  parallelGroup: number;
  dependsOnStepIds: string[];
  status: WorkflowStepStatus;
  attempt: number;
  outputMessageId: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  idempotencyKey: string;
  status: WorkflowRunStatus;
  coordinatorAgentId: string;
  requestedAgentIds: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  steps: WorkflowStepRecord[];
}

export interface WorkflowEventRecord {
  id: string;
  runId: string;
  sequence: number;
  type: WorkflowEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface FederationSnapshotRecord {
  config: FederationConfigRecord | null;
  capsules: MemoryCapsuleRecord[];
  runs: WorkflowRunRecord[];
}

export type StreamEvent =
  | { type: 'message.accepted'; message: MessageRecord }
  | { type: 'message.created'; message: MessageRecord }
  | { type: 'artifacts.attached'; messageId: string; artifacts: ArtifactRecord[] }
  | { type: 'artifacts.delivery'; delivery: ArtifactDeliveryRecord }
  | { type: 'routing.resolved'; routing: RoutingPlanRecord }
  | { type: 'team.activity'; activity: TeamActivityRecord }
  | { type: 'participants.updated'; participants: ConversationParticipantRecord[] }
  | { type: 'workflow.run'; run: WorkflowRunRecord; replayed?: boolean }
  | { type: 'workflow.step'; step: WorkflowStepRecord }
  | { type: 'workflow.event'; event: WorkflowEventRecord }
  | { type: 'memory.capsule'; capsule: MemoryCapsuleRecord }
  | { type: 'workflow.replayed'; runId: string; eventCount: number }
  | { type: 'run.started'; runId: string; agentId?: string }
  | { type: 'run.status'; runId: string; status: string; agentId?: string }
  | { type: 'content.delta'; runId: string; messageId: string; delta: string; authorId?: string }
  | { type: 'artifact.created'; runId: string; artifact: ArtifactRecord }
  | { type: 'run.completed'; runId: string; message: MessageRecord; agentId?: string }
  | { type: 'run.failed'; runId: string; error: string; agentId?: string };

export interface CreateConversationInput {
  systemId: SystemId;
  agentId: string;
  title?: string;
  federated?: boolean;
}

export interface UpdateConversationInput {
  title?: string;
  pinned?: boolean;
  status?: ConversationStatus;
  draft?: string;
  lastReadMessageId?: string | null;
}

export interface BranchConversationInput {
  fromMessageId?: string | null;
  title?: string;
}

export interface SendMessageInput {
  content: string;
  clientMessageId?: string;
  parentMessageId?: string | null;
  artifactIds?: string[];
  targetAgentIds?: string[];
  workflowMode?: 'chat' | 'federated';
  idempotencyKey?: string;
}

export interface UpdateParticipantsInput {
  agentIds: string[];
  leadAgentId?: string;
}

export interface UpdateParticipantStateInput {
  state: ParticipantState;
}

export interface CreateMemoryCapsuleInput {
  sourceSystemId: SystemId;
  targetSystemId: SystemId;
  title: string;
  content: string;
  sourceMessageIds?: string[];
}

export interface UpdateMemoryCapsuleInput {
  title?: string;
  content?: string;
  status?: MemoryCapsuleStatus;
}

export interface UploadProgressRecord {
  localId: string;
  filename: string;
  progress: number;
  state: 'uploading' | 'complete' | 'failed';
  artifactId?: string;
  error?: string;
}
