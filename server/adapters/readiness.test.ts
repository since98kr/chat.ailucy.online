import { describe, expect, it } from 'vitest';
import { readinessPayloadError, readinessStreamError, sanitizeReadinessDetail } from './readiness.js';

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
