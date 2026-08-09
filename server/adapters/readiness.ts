import type { SystemId } from '../../shared/contracts.js';
import { httpAdapterConfig } from './http.js';

export type AdapterReadinessRecord = {
  ok: boolean;
  detail: string;
  latencyMs: number;
};

const READINESS_SYSTEMS: SystemId[] = ['hermes', 'letta'];

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function normalizePath(value: string) {
  return value.startsWith('/') ? value : `/${value}`;
}

function truthy(value: string | undefined) {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function sanitizeReadinessDetail(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function readinessPayloadError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const object = payload as Record<string, unknown>;
  const value = object.error;
  let raw = '';
  if (typeof value === 'string') {
    raw = value;
  } else if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).message === 'string') {
    raw = String((value as Record<string, unknown>).message);
  } else if (object.type === 'run.failed' && typeof object.message === 'string') {
    raw = object.message;
  }
  return sanitizeReadinessDetail(raw) || null;
}

export function readinessStreamError(body: string): string | null {
  for (const rawLine of body.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line || line === '[DONE]') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const error = readinessPayloadError(payload);
    if (error) return error;
  }
  return null;
}

export function readinessProbeEnabled(systemId: SystemId) {
  return truthy(process.env[`${systemId.toUpperCase()}_READINESS_PROBE_ENABLED`]);
}

export async function probeAdapterReadiness(systemId: SystemId): Promise<AdapterReadinessRecord | null> {
  if (!readinessProbeEnabled(systemId)) return null;

  const prefix = systemId.toUpperCase();
  const config = httpAdapterConfig(systemId);
  if (!config) {
    return {
      ok: false,
      detail: `${prefix}_BASE_URL is required for the generation readiness probe`,
      latencyMs: 0,
    };
  }

  const model = process.env[`${prefix}_READINESS_PROBE_MODEL`]?.trim()
    || Object.values(config.modelMap ?? {})[0]
    || config.agentId?.trim()
    || '';
  if (config.protocol === 'openai' && !model) {
    return {
      ok: false,
      detail: `${prefix}_MODEL_MAP_JSON or ${prefix}_READINESS_PROBE_MODEL is required for the generation readiness probe`,
      latencyMs: 0,
    };
  }

  const prompt = process.env[`${prefix}_READINESS_PROBE_PROMPT`]?.trim() || 'ping';
  const body = config.protocol === 'openai'
    ? { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 1 }
    : {
      stream: false,
      system_id: systemId,
      agent_id: model || config.agentId,
      messages: [{ role: 'user', content: prompt }],
      metadata: { source: 'chat.ailucy.online', probe: 'generation-readiness' },
    };

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${trimSlash(config.baseUrl)}${normalizePath(config.chatPath)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, text/event-stream, application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const text = await response.text().catch(() => '');
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      return {
        ok: false,
        detail: sanitizeReadinessDetail(`generation probe rejected: ${response.status} ${text}`),
        latencyMs,
      };
    }
    const error = readinessStreamError(text);
    if (error) {
      return { ok: false, detail: `backend generation error: ${error}`, latencyMs };
    }
    return { ok: true, detail: `generation probe accepted: ${response.status}`, latencyMs };
  } catch (error) {
    return {
      ok: false,
      detail: sanitizeReadinessDetail(error instanceof Error ? error.message : 'generation probe failed'),
      latencyMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function adapterReadiness(): Promise<Record<string, AdapterReadinessRecord | null>> {
  const entries = await Promise.all(READINESS_SYSTEMS.map(async (systemId) => (
    [systemId, await probeAdapterReadiness(systemId)] as const
  )));
  return Object.fromEntries(entries);
}
