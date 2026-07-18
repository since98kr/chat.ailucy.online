import type {
  ArtifactRecord,
  BranchConversationInput,
  ConversationDetail,
  ConversationRecord,
  ConversationSearchResult,
  ConversationStatus,
  CreateConversationInput,
  SendMessageInput,
  StreamEvent,
  SystemId,
  UpdateConversationInput,
} from '../shared/contracts';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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

export async function streamMessage(
  conversationId: string,
  input: SendMessageInput,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
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
