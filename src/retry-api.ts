import type { StreamEvent } from '../shared/contracts';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

function signalAuthenticationRequired(status: number) {
  if (status === 401 || status === 403) {
    window.dispatchEvent(new CustomEvent('chat-auth-required', { detail: { status } }));
  }
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

export async function retryAssistantResponse(
  messageId: string,
  mode: 'retry' | 'regenerate',
  idempotencyKey: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${API_BASE}/api/messages/${messageId}/retry/stream`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, idempotencyKey }),
    signal,
  });
  return consumeNdjson(response, onEvent);
}
