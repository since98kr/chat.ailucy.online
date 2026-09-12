import type { ChatBackendAdapter } from './types.js';

export const MAX_PROGRESS_STATUS_LENGTH = 180;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const NAMED_SECRET = /["']?\b(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|authorization|cookie)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const OPENAI_STYLE_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_UNIX_PATH = /\/(?:home|Users|root|etc|var|tmp|srv|opt|run)(?:\/[^\s,;)}\]]*)?/g;
const PRIVATE_WINDOWS_PATH = /\b[A-Za-z]:\\(?:Users|Windows|ProgramData|Temp)\\[^\s,;)}\]]+/g;
const RAW_ARGUMENT_BLOB = /(?:["']?\b(?:args|arguments|parameters|input)\b["']?\s*[:=]\s*[\[{]|\btool(?:_name)?\b\s*[:=].*\b(?:args|arguments|parameters|input)\b|(?:^|[\s=:])(?:\{|\[\s*\{)\s*(?:["'][^"']+["']|[A-Za-z_][\w.-]*)\s*:)/i;

function normalize(value: string) {
  return value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

function redactSensitiveMaterial(value: string) {
  return value
    .replace(BEARER_SECRET, 'Bearer [redacted]')
    .replace(NAMED_SECRET, (_match, key: string) => `${key}=[redacted]`)
    .replace(OPENAI_STYLE_SECRET, '[redacted]')
    .replace(PRIVATE_UNIX_PATH, '[path]')
    .replace(PRIVATE_WINDOWS_PATH, '[path]');
}

export function sanitizeProgressStatus(value: unknown): string {
  const normalized = normalize(typeof value === 'string' ? value : '');
  if (!normalized) return '작업 진행 중';
  if (RAW_ARGUMENT_BLOB.test(normalized)) return '도구 실행 중';
  const redacted = normalize(redactSensitiveMaterial(normalized));
  if (!redacted) return '작업 진행 중';
  if (redacted.length <= MAX_PROGRESS_STATUS_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_PROGRESS_STATUS_LENGTH - 1).trimEnd()}…`;
}

/**
 * Server-side adapter boundary for user-visible progress. Backends may emit
 * arbitrary status strings; Chat must never forward those strings directly to
 * run.status/transcript consumers.
 */
export function wrapProgressSanitizer(adapter: ChatBackendAdapter): ChatBackendAdapter {
  return {
    systemId: adapter.systemId,
    health: () => adapter.health(),
    async *streamReply(request) {
      for await (const item of adapter.streamReply(request)) {
        if (item.type === 'status') {
          yield { ...item, status: sanitizeProgressStatus(item.status) };
          continue;
        }
        yield item;
      }
    },
  };
}
