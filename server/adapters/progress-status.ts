import type { ChatBackendAdapter } from './types.js';

export const MAX_PROGRESS_STATUS_LENGTH = 180;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BEARER_SECRET = /\bBearer\s+\S+/i;
// Basic uses token68/base64-shaped credentials, which may be very short
// (for example YTpi for a:b). Sentence punctuation is a valid display boundary.
const BASIC_AUTH_SECRET = /\bBasic\s+[A-Za-z0-9+/_-]+={0,2}(?=[\s.,;:!?)}\]"']|$)/i;
const OPENAI_STYLE_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b/i;
const AUTHORITY_USERINFO = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s@]+@/i;
const URI_SCHEME = /\b([A-Za-z][A-Za-z0-9+.-]*):(?=\S)/g;
const HTTP_URL = /https?:\/\/[^\s<>"']+/gi;
const ASSIGNED_FIELD_KEY = /["']?\b([A-Za-z][A-Za-z0-9_.-]{0,127})\b["']?\s*[:=]/g;
const JSON_ARGUMENT_BLOB = /(?:^|[\s=:,(\[{])["']?(?:command|cmd|query|path|input|args|arguments|parameters)["']?\s*[:=]\s*(?:[\[{"']|\S)/i;
const BRIDGE_SAFE_LABEL_BARE = `[A-Za-z0-9_./:@-]{1,160}`;
const BRIDGE_SAFE_LABEL_QUOTED = `(?:"[A-Za-z0-9_./:@-][A-Za-z0-9_./:@ -]{0,159}"|'[A-Za-z0-9_./:@-][A-Za-z0-9_./:@ -]{0,159}')`;
const TOOL_IDENTIFIER = `(?:${BRIDGE_SAFE_LABEL_QUOTED}|${BRIDGE_SAFE_LABEL_BARE})`;
// Capture only the tool marker/name, not the rest of the line. The tool-name
// grammar mirrors the bridge's bounded SAFE_LABEL for quoted names (including
// spaces/slashes) while unquoted names stop before whitespace. Everything after
// the captured identifier remains available to the raw-argument detector.
const TOOL_MARKER = new RegExp(
  `\\b(?:tool(?:_name|_call)?\\s*[:=]\\s*${TOOL_IDENTIFIER}|(?:tool\\s+call|tool_call)\\s*:?\\s*${TOOL_IDENTIFIER})`,
  'i',
);
// Backends outside the native bridge may use Unicode tool identifiers. These
// broader identifiers exist only to find a bounded tool name so any following
// payload fails closed; they are never used to approve/preserve a bridge label.
const ANY_QUOTED_TOOL_IDENTIFIER = `(?:"[^"\\r\\n]{1,160}"|'[^'\\r\\n]{1,160}')`;
const ANY_BARE_TOOL_IDENTIFIER = `[^\\s=:,()\\[\\]{}"']{1,160}`;
const ANY_TOOL_IDENTIFIER = `(?:${ANY_QUOTED_TOOL_IDENTIFIER}|${ANY_BARE_TOOL_IDENTIFIER})`;
const BROAD_TOOL_MARKER = new RegExp(
  `\\b(?:tool(?:_name|_call)?\\s*[:=]\\s*${ANY_TOOL_IDENTIFIER}|(?:tool\\s+call|tool_call)\\s*:?\\s*${ANY_TOOL_IDENTIFIER})`,
  'iu',
);
const SAFE_TOOL_STATUS = /^(?:ready|completed|running|started|starting|waiting|done|idle)[.!]?$/i;
// Native bridge lifecycle names are produced from its bounded SAFE_LABEL.
// Preserve all documented state transitions, then independently reject obvious
// secret/path-shaped labels before exposing them to transcript consumers.
const SAFE_BRIDGE_LIFECYCLE = /^tool\.(?:approval_required|approved|running|completed|failed):([A-Za-z0-9_./:@-][A-Za-z0-9_./:@ -]{0,159})$/;
const BRIDGE_RUNTIME_PREFIX = /^runtime\./;
const SAFE_BRIDGE_RUNTIME_MODEL = /^runtime\.model:([A-Za-z0-9_./:@-][A-Za-z0-9_./:@ -]{0,159})$/;
const SAFE_BRIDGE_RUNTIME_PERMISSION = /^runtime\.permission:(unrestricted|standard|acceptEdits|strict|unknown)$/;
const SAFE_BRIDGE_RUNTIME_BOOLEAN = /^runtime\.(?:mcp_advertised|slash_commands_advertised):(true|false)$/;
const SAFE_BRIDGE_RUNTIME_CAPABILITIES = /^runtime\.capabilities:tools=\d{1,6};skill_sources=\d{1,6};mcp=\d{1,6};commands=\d{1,6};memfs=(?:true|false)$/;
const FILE_URL = /\bfile:\/\//i;
const WINDOWS_DRIVE_PATH = /\b[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /\\\\[^\s]/;
const WINDOWS_ROOTED_PATH = /(^|[\s([{:;,="'])\\(?=\S)/u;
// HTTP(S) URLs are protected before these checks. Absolute and dot-relative
// paths are always private. Ordinary slash/backslash-separated relative paths
// are also private in general progress text, but bridge-owned labels/models are
// allowed to contain safe slashes such as mcp/search and openai/gpt-*.
const ABSOLUTE_SLASH_PATH = /(^|[^A-Za-z0-9/])\/{1,2}(?=\S)/u;
const RELATIVE_PRIVATE_PATH = /(^|[\s([{:;,])\.{1,2}[\\/](?=\S)/u;
const BARE_RELATIVE_PATH = /(^|[\s([{:;,="'])[^\s\\/<>"']+[\\/](?:[^\s\\/<>"']+[\\/])*[^\s\\/<>"']+/u;

const SENSITIVE_WORDS = new Set([
  'authorization',
  'cookie',
  'credential',
  'password',
  'secret',
  'session',
  'signature',
  'token',
  'key',
]);

function normalize(value: string) {
  return value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

function boundedStatus(value: string) {
  if (value.length <= MAX_PROGRESS_STATUS_LENGTH) return value;
  return `${value.slice(0, MAX_PROGRESS_STATUS_LENGTH - 1).trimEnd()}…`;
}

function isSensitiveAssignedField(key: string) {
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_WORDS.has(word))) return true;

  const collapsed = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (/(?:authorization|cookie|credential|password|secret|signature|token)/.test(collapsed)) return true;
  if (/^(?:session|sessionid|sessionkey|sessiontoken|sid)$/.test(collapsed)) return true;
  // Case/delimiter splitting cannot expose KEY in forms such as APIKEY/apikey.
  // Recognize the common credential compounds without treating arbitrary words
  // such as "monkey" as credentials.
  return /^(?:api|clientapi|client|private|server|sshprivate|ssh|access|signing|encryption|auth)?key$/.test(collapsed);
}

function hasSensitiveAssignedField(value: string) {
  ASSIGNED_FIELD_KEY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNED_FIELD_KEY.exec(value))) {
    if (isSensitiveAssignedField(match[1])) return true;
  }
  return false;
}

function decodedFieldKey(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // A malformed key may still contain a successfully decodable credential
    // prefix (for example %74oken%ZZ). Treat decode failure as tainted instead
    // of falling back to the raw undecoded spelling.
    return null;
  }
}

function httpUrlHasSensitiveKey(rawUrl: string) {
  const queryIndex = rawUrl.indexOf('?');
  const hashIndex = rawUrl.indexOf('#');
  const sections: string[] = [];

  // Only a query before the fragment is the URL's main query. A '?' inside the
  // fragment belongs to a routed fragment and is handled separately below.
  if (queryIndex >= 0 && (hashIndex < 0 || queryIndex < hashIndex)) {
    const end = hashIndex >= 0 ? hashIndex : rawUrl.length;
    sections.push(rawUrl.slice(queryIndex + 1, end));
  }
  if (hashIndex >= 0) {
    const fragment = rawUrl.slice(hashIndex + 1);
    const fragmentQueryIndex = fragment.indexOf('?');
    sections.push(
      fragmentQueryIndex >= 0
        ? fragment.slice(fragmentQueryIndex + 1)
        : fragment.replace(/^\?/, ''),
    );
  }

  for (const section of sections) {
    for (const field of section.split(/[&;]/)) {
      const equals = field.indexOf('=');
      if (equals <= 0) continue;
      const key = decodedFieldKey(field.slice(0, equals));
      if (key === null || isSensitiveAssignedField(key)) return true;
    }
  }
  return false;
}

function hasSensitiveHttpUrl(value: string) {
  const matches = value.match(HTTP_URL) ?? [];
  return matches.some((rawUrl) => httpUrlHasSensitiveKey(rawUrl));
}

function hasNonHttpUri(value: string) {
  URI_SCHEME.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URI_SCHEME.exec(value))) {
    const scheme = match[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return true;
  }
  return false;
}

function hasCredentialMaterial(value: string) {
  return BEARER_SECRET.test(value)
    || BASIC_AUTH_SECRET.test(value)
    || OPENAI_STYLE_SECRET.test(value)
    || AUTHORITY_USERINFO.test(value)
    || hasSensitiveHttpUrl(value)
    || hasSensitiveAssignedField(value);
}

function hasSensitiveMaterial(value: string) {
  return hasCredentialMaterial(value) || hasNonHttpUri(value);
}

function hasRawToolArguments(value: string) {
  if (JSON_ARGUMENT_BLOB.test(value) && /[\[{]/.test(value)) return true;
  const marker = TOOL_MARKER.exec(value) ?? BROAD_TOOL_MARKER.exec(value);
  if (!marker) return false;
  const remainder = value.slice((marker.index ?? 0) + marker[0].length).trim();
  if (!remainder) return false;
  // Once a tool marker and tool name are identified, any additional payload is
  // treated as tool plumbing unless it is one of a tiny set of presentation-only
  // lifecycle words. This covers positional scalars as well as structured/flag
  // syntaxes without trying to enumerate every possible argument grammar.
  return !SAFE_TOOL_STATUS.test(remainder);
}

function compactFieldBoundary(rawUrl: string) {
  const queryIndex = rawUrl.indexOf('?');
  const hashIndex = rawUrl.indexOf('#');
  const urlDataStart = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? rawUrl.length;
  const boundary = /[;,&](?=[A-Za-z_][A-Za-z0-9_.-]*[:=])/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(rawUrl))) {
    const delimiter = rawUrl[match.index];
    // Comma-delimited field shapes remain fail-closed even after query data has
    // begun. Semicolon/ampersand field shapes are external only before a real
    // query/fragment starts, preserving valid query parameters inside the URL.
    if (delimiter === ',' || match.index < urlDataStart) return match.index;
  }
  return -1;
}

function protectHttpUrls(value: string) {
  const urls: string[] = [];
  const protectedValue = value.replace(HTTP_URL, (rawUrl) => {
    const adjacentField = compactFieldBoundary(rawUrl);
    const url = adjacentField >= 0 ? rawUrl.slice(0, adjacentField) : rawUrl;
    const suffix = adjacentField >= 0 ? rawUrl.slice(adjacentField) : '';
    const token = `\uE000${urls.length}\uE001`;
    urls.push(url);
    return `${token}${suffix}`;
  });
  return { protectedValue, urls };
}

function hasExplicitPrivatePath(value: string) {
  if (
    FILE_URL.test(value)
    || WINDOWS_DRIVE_PATH.test(value)
    || WINDOWS_UNC_PATH.test(value)
    || WINDOWS_ROOTED_PATH.test(value)
  ) return true;
  const { protectedValue } = protectHttpUrls(value);
  return ABSOLUTE_SLASH_PATH.test(protectedValue) || RELATIVE_PRIVATE_PATH.test(protectedValue);
}

function hasPrivatePath(value: string) {
  if (hasExplicitPrivatePath(value)) return true;
  const { protectedValue } = protectHttpUrls(value);
  return BARE_RELATIVE_PATH.test(protectedValue);
}

function isSafeBridgeRuntimeStatus(value: string) {
  const model = SAFE_BRIDGE_RUNTIME_MODEL.exec(value);
  if (model) return !hasCredentialMaterial(model[1]) && !hasExplicitPrivatePath(model[1]);

  if (SAFE_BRIDGE_RUNTIME_PERMISSION.test(value)) return true;

  return SAFE_BRIDGE_RUNTIME_BOOLEAN.test(value) || SAFE_BRIDGE_RUNTIME_CAPABILITIES.test(value);
}

export function sanitizeProgressStatus(value: unknown): string {
  const normalized = normalize(typeof value === 'string' ? value : '');
  if (!normalized) return '작업 진행 중';

  // Preserve only the bridge's documented bounded lifecycle contract before
  // generic URI detection interprets a lifecycle state as a scheme. Slash-bearing
  // SAFE_LABEL names are allowed here, but explicit filesystem path shapes and
  // credential material are still rejected before the transcript boundary.
  const bridgeLifecycle = SAFE_BRIDGE_LIFECYCLE.exec(normalized);
  if (
    bridgeLifecycle
    && !hasCredentialMaterial(bridgeLifecycle[1])
    && !hasExplicitPrivatePath(bridgeLifecycle[1])
  ) return boundedStatus(normalized);

  // `runtime.*` is a bridge-owned namespace. Preserve only the exact documented
  // runtime evidence grammar; malformed or unknown runtime statuses fail closed
  // instead of falling through as apparently benign human-readable text.
  if (isSafeBridgeRuntimeStatus(normalized)) return boundedStatus(normalized);
  if (BRIDGE_RUNTIME_PREFIX.test(normalized)) return '작업 진행 중';

  // Tool arguments are never presentation text. Collapse the whole line rather
  // than attempting to redact an unbounded family of argument syntaxes.
  if (hasRawToolArguments(normalized)) return '도구 실행 중';

  // Security/privacy boundary: once a progress line is tainted by credentials,
  // non-HTTP backend URIs, or a local/private path, do not partially preserve
  // it. Benign human-readable status and complete HTTP(S) URLs remain visible.
  if (hasSensitiveMaterial(normalized) || hasPrivatePath(normalized)) return '작업 진행 중';

  return boundedStatus(normalized);
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
