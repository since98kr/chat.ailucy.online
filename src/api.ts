import type {
  AgentRecord,
  ArtifactRecord,
  BranchConversationInput,
  ConversationDetail,
  ConversationParticipantRecord,
  ConversationRecord,
  ConversationSearchResult,
  ConversationStatus,
  CreateConversationInput,
  CreateMemoryCapsuleInput,
  FederationConfigRecord,
  FederationSnapshotRecord,
  MemoryCapsuleRecord,
  RoutingPlanRecord,
  SendMessageInput,
  StreamEvent,
  SystemId,
  TeamActivityRecord,
  UpdateConversationInput,
  UpdateMemoryCapsuleInput,
  UpdateParticipantsInput,
  WorkflowEventRecord,
  WorkflowRunRecord,
} from '../shared/contracts';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

function signalAuthenticationRequired(status: number) {
  if (status === 401 || status === 403) {
    window.dispatchEvent(new CustomEvent('chat-auth-required', { detail: { status } }));
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    signalAuthenticationRequired(response.status);
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message ?? payload?.error ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function consumeNdjson(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.ok || !response.body) {
    signalAuthenticationRequired(response.status);
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message ?? payload?.error ?? `${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as StreamEvent);
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  const trailing = buffer.trim();
  if (trailing) onEvent(JSON.parse(trailing) as StreamEvent);
}

export async function listAgents(systemId?: SystemId) {
  const query = new URLSearchParams();
  if (systemId) query.set('systemId', systemId);
  const suffix = query.size ? `?${query}` : '';
  const response = await requestJson<{ agents: AgentRecord[] }>(`/api/agents${suffix}`);
  return response.agents;
}

export async function listParticipants(conversationId: string) {
  const response = await requestJson<{ participants: ConversationParticipantRecord[] }>(
    `/api/conversations/${conversationId}/participants`,
  );
  return response.participants;
}

export async function updateParticipants(conversationId: string, input: UpdateParticipantsInput) {
  const response = await requestJson<{ participants: ConversationParticipantRecord[] }>(
    `/api/conversations/${conversationId}/participants`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
  return response.participants;
}

export async function listTeamActivity(conversationId: string, limit = 100) {
  const response = await requestJson<{ activities: TeamActivityRecord[] }>(
    `/api/conversations/${conversationId}/team-activity?limit=${limit}`,
  );
  return response.activities;
}

export async function previewRouting(conversationId: string, content: string, targetAgentIds: string[] = []) {
  const response = await requestJson<{ routing: RoutingPlanRecord }>(
    `/api/conversations/${conversationId}/routing/preview`,
    { method: 'POST', body: JSON.stringify({ content, targetAgentIds }) },
  );
  return response.routing;
}

export async function listConversations(systemId: SystemId, status: ConversationStatus = 'active') {
  const query = new URLSearchParams({ systemId, status });
  const response = await requestJson<{ conversations: ConversationRecord[] }>(`/api/conversations?${query}`);
  return response.conversations;
}

export async function searchConversations(
  value: string,
  options: { systemId?: SystemId; status?: ConversationStatus; limit?: number } = {},
) {
  const query = new URLSearchParams({ q: value });
  if (options.systemId) query.set('systemId', options.systemId);
  if (options.status) query.set('status', options.status);
  if (options.limit) query.set('limit', String(options.limit));
  const response = await requestJson<{ results: ConversationSearchResult[] }>(`/api/search?${query}`);
  return response.results;
}

export async function getConversation(id: string) {
  const response = await requestJson<{ conversation: ConversationDetail }>(`/api/conversations/${id}`);
  return response.conversation;
}

export async function createConversation(input: CreateConversationInput) {
  const response = await requestJson<{ conversation: ConversationDetail }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.conversation;
}

export async function branchConversation(id: string, input: BranchConversationInput = {}) {
  const response = await requestJson<{ conversation: ConversationDetail }>(`/api/conversations/${id}/branch`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.conversation;
}

export async function updateConversation(id: string, input: UpdateConversationInput) {
  const response = await requestJson<{ conversation: ConversationDetail }>(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return response.conversation;
}

export async function permanentlyDeleteConversation(id: string) {
  await requestJson<void>(`/api/conversations/${id}`, { method: 'DELETE' });
}

export async function getFederationSnapshot(conversationId: string) {
  const response = await requestJson<{ federation: FederationSnapshotRecord }>(
    `/api/conversations/${conversationId}/federation`,
  );
  return response.federation;
}

export async function enableFederation(conversationId: string, coordinatorAgentId = '[Hermes] Lucy') {
  const response = await requestJson<{ config: FederationConfigRecord; federation: FederationSnapshotRecord }>(
    `/api/conversations/${conversationId}/federation`,
    { method: 'POST', body: JSON.stringify({ coordinatorAgentId }) },
  );
  return response.federation;
}

export async function disableFederation(conversationId: string) {
  const response = await requestJson<{ config: FederationConfigRecord | null }>(
    `/api/conversations/${conversationId}/federation`,
    { method: 'DELETE' },
  );
  return response.config;
}

export async function createMemoryCapsule(conversationId: string, input: CreateMemoryCapsuleInput) {
  const response = await requestJson<{ capsule: MemoryCapsuleRecord }>(
    `/api/conversations/${conversationId}/memory-capsules`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.capsule;
}

export async function updateMemoryCapsule(capsuleId: string, input: UpdateMemoryCapsuleInput) {
  const response = await requestJson<{ capsule: MemoryCapsuleRecord }>(
    `/api/memory-capsules/${capsuleId}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return response.capsule;
}

export async function listWorkflowRuns(conversationId: string, limit = 30) {
  const response = await requestJson<{ runs: WorkflowRunRecord[] }>(
    `/api/conversations/${conversationId}/workflows?limit=${limit}`,
  );
  return response.runs;
}

export async function listWorkflowEvents(runId: string, after = 0) {
  const response = await requestJson<{ events: WorkflowEventRecord[] }>(
    `/api/workflows/${runId}/events?after=${after}`,
  );
  return response.events;
}

export async function resumeWorkflow(
  runId: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${API_BASE}/api/workflows/${runId}/resume/stream`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  });
  return consumeNdjson(response, onEvent);
}

export async function streamMessage(
  conversationId: string,
  input: SendMessageInput,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  return consumeNdjson(response, onEvent);
}

export function uploadArtifact(
  conversationId: string,
  file: File,
  onProgress?: (progress: number) => void,
) {
  return new Promise<ArtifactRecord>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    request.open('POST', `${API_BASE}/api/conversations/${conversationId}/artifacts`);
    request.withCredentials = true;
    request.responseType = 'json';
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        const payload = request.response as { artifact: ArtifactRecord };
        onProgress?.(100);
        resolve(payload.artifact);
      } else {
        signalAuthenticationRequired(request.status);
        reject(new Error(request.response?.error ?? `${request.status} ${request.statusText}`));
      }
    });
    request.addEventListener('error', () => reject(new Error('파일 업로드 연결이 중단됐습니다.')));
    request.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));
    request.send(form);
  });
}

export function conversationExportUrl(id: string) {
  return `${API_BASE}/api/conversations/${id}/export/markdown`;
}

export function artifactDownloadUrl(id: string) {
  return `${API_BASE}/api/artifacts/${id}/download`;
}

export function artifactContentUrl(id: string) {
  return `${API_BASE}/api/artifacts/${id}/content`;
}
