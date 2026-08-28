import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAdapterReadiness, readinessPayloadError, readinessStreamError, sanitizeReadinessDetail } from './readiness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('readinessPayloadError', () => {
  it('extracts a string error field', () => {
    expect(readinessPayloadError({ error: 'Codex auth is missing access_token.' }))
      .toBe('Codex auth is missing access_token.');
  });

  it('extracts a nested error message', () => {
    expect(readinessPayloadError({ error: { message: 'invalid api key' } })).toBe('invalid api key');
  });

  it('extracts a run.failed message', () => {
    expect(readinessPayloadError({ type: 'run.failed', message: 'backend refused the run' }))
      .toBe('backend refused the run');
  });

  it('returns null for a healthy payload', () => {
    expect(readinessPayloadError({ choices: [{ message: { content: 'pong' } }] })).toBeNull();
  });

  it('returns null for a non-object payload', () => {
    expect(readinessPayloadError('pong')).toBeNull();
    expect(readinessPayloadError(null)).toBeNull();
  });
});

describe('readinessStreamError', () => {
  it('detects an expired upstream credential inside an SSE stream', () => {
    const body = [
      ': keep-alive',
      'data: {"type":"run.started"}',
      'data: {"error":"Codex auth is missing access_token. Run hermes auth to re-authenticate."}',
      'data: [DONE]',
    ].join('\n');
    expect(readinessStreamError(body))
      .toBe('Codex auth is missing access_token. Run hermes auth to re-authenticate.');
  });

  it('detects an error inside a non-streamed JSON body', () => {
    expect(readinessStreamError('{"error":{"message":"model not approved"}}')).toBe('model not approved');
  });

  it('detects a run.failed event inside an NDJSON stream', () => {
    const body = [
      '{"type":"run.started"}',
      '{"type":"run.failed","message":"upstream quota exhausted"}',
    ].join('\n');
    expect(readinessStreamError(body)).toBe('upstream quota exhausted');
  });

  it('returns null when the stream carries only content', () => {
    const body = [
      '{"delta":"po"}',
      '{"delta":"ng"}',
      '[DONE]',
    ].join('\n');
    expect(readinessStreamError(body)).toBeNull();
  });

  it('ignores unparsable lines', () => {
    expect(readinessStreamError('not json at all')).toBeNull();
  });
});

describe('sanitizeReadinessDetail', () => {
  it('collapses control characters and whitespace', () => {
    expect(sanitizeReadinessDetail('  token\n\texpired\r\n  ')).toBe('token expired');
  });

  it('truncates long details to 500 characters', () => {
    expect(sanitizeReadinessDetail('x'.repeat(900))).toHaveLength(500);
  });
});


describe('probeAdapterReadiness', () => {
  it('uses the canonical OpenClaw Letta target for generation readiness', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('LETTA_READINESS_PROBE_ENABLED', 'true');
    vi.stubEnv('LETTA_PROTOCOL', 'openclaw');
    vi.stubEnv('LETTA_BASE_URL', 'http://127.0.0.1:18792');
    vi.stubEnv('LETTA_CHAT_PATH', '/v1/chat/completions');
    vi.stubEnv('LETTA_OPENCLAW_AGENT_TARGET', 'openclaw/main');
    vi.stubEnv('LETTA_OPENCLAW_SESSION_PREFIX', 'chat-v2');

    const result = await probeAdapterReadiness('letta');
    expect(result?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body).toMatchObject({
      model: 'openclaw/main',
      user: 'chat-v2:readiness-probe',
      stream: false,
    });
  });
});
