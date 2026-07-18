import type { AdapterHealthRecord, MessageRecord, SystemId } from '../../shared/contracts.js';
import type { AdapterRequest, AdapterStreamItem, ChatBackendAdapter } from './types.js';

type HttpAdapterConfig = {
  baseUrl: string;
  chatPath: string;
  healthPath: string;
  apiKey?: string;
  agentId?: string;
  timeoutMs: number;
};

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function normalizePath(value: string) {
  return value.startsWith('/') ? value : `/${value}`;
}

function extractDelta(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const object = payload as Record<string, unknown>;
  if (typeof object.delta === 'string') return object.delta;
  if (typeof object.content === 'string') return object.content;
  if (object.message && typeof object.message === 'object') {
    const content = (object.message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
  }
  if (Array.isArray(object.choices)) {
    const choice = object.choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === 'string') return delta.content;
    const message = choice?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === 'string') return message.content;
  }
  return null;
}

function extractStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const object = payload as Record<string, unknown>;
  if (object.type === 'status' && typeof object.status === 'string') return object.status;
  if (typeof object.status === 'string' && !extractDelta(payload)) return object.status;
  return null;
}

function toBackendMessages(history: MessageRecord[]) {
  return history
    .filter((message) => message.role !== 'system' || message.content.trim())
    .map((message) => ({
      role: message.role,
      content: message.content,
      author_id: message.authorId,
      message_id: message.id,
    }));
}

export class HttpAgentAdapter implements ChatBackendAdapter {
  readonly systemId: SystemId;
  readonly config: HttpAdapterConfig;

  constructor(systemId: SystemId, config: HttpAdapterConfig) {
    this.systemId = systemId;
    this.config = config;
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson, text/event-stream, application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  async health(): Promise<AdapterHealthRecord> {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(
        `${trimSlash(this.config.baseUrl)}${normalizePath(this.config.healthPath)}`,
        { headers: this.headers(), signal: controller.signal },
      );
      return {
        ok: response.ok,
        mode: 'http',
        detail: response.ok ? `${response.status} ${response.statusText}` : `Health probe failed: ${response.status}`,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      return {
        ok: false,
        mode: 'http',
        detail: error instanceof Error ? error.message : 'Health probe failed',
        latencyMs: Math.round(performance.now() - started),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async *streamReply(request: AdapterRequest): AsyncGenerator<AdapterStreamItem> {
    const response = await fetch(
      `${trimSlash(this.config.baseUrl)}${normalizePath(this.config.chatPath)}`,
      {
        method: 'POST',
        headers: this.headers(),
        signal: request.signal,
        body: JSON.stringify({
          stream: true,
          system_id: this.systemId,
          agent_id: this.config.agentId ?? request.conversation.agentId,
          conversation_id: request.conversation.id,
          messages: toBackendMessages(request.history),
          metadata: {
            source: 'chat.ailucy.online',
            user_message_id: request.userMessage.id,
          },
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${this.systemId} backend ${response.status}: ${detail.slice(0, 500)}`);
    }

    if (!response.body) {
      const payload = await response.json().catch(() => null);
      const delta = extractDelta(payload);
      if (delta) yield { type: 'delta', delta };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        let line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (!line || line === '[DONE]') continue;
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          yield { type: 'delta', delta: line };
          continue;
        }
        const status = extractStatus(payload);
        if (status) yield { type: 'status', status };
        const delta = extractDelta(payload);
        if (delta) yield { type: 'delta', delta };
      }
      if (done) break;
    }

    const trailing = buffer.trim().replace(/^data:\s*/, '');
    if (trailing && trailing !== '[DONE]') {
      try {
        const payload = JSON.parse(trailing) as unknown;
        const status = extractStatus(payload);
        if (status) yield { type: 'status', status };
        const delta = extractDelta(payload);
        if (delta) yield { type: 'delta', delta };
      } catch {
        yield { type: 'delta', delta: trailing };
      }
    }
  }
}

export function httpAdapterConfig(systemId: SystemId): HttpAdapterConfig | null {
  const prefix = systemId.toUpperCase();
  const baseUrl = process.env[`${prefix}_BASE_URL`]?.trim();
  if (!baseUrl) return null;
  return {
    baseUrl,
    chatPath: process.env[`${prefix}_CHAT_PATH`] ?? '/v1/chat/stream',
    healthPath: process.env[`${prefix}_HEALTH_PATH`] ?? '/health',
    apiKey: process.env[`${prefix}_API_KEY`],
    agentId: process.env[`${prefix}_AGENT_ID`],
    timeoutMs: Number(process.env[`${prefix}_TIMEOUT_MS`] ?? 10_000),
  };
}
