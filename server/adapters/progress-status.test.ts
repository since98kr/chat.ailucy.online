import { describe, expect, it } from 'vitest';
import type { AdapterStreamItem, ChatBackendAdapter } from './types.js';
import { MAX_PROGRESS_STATUS_LENGTH, sanitizeProgressStatus, wrapProgressSanitizer } from './progress-status.js';

function fakeAdapter(items: AdapterStreamItem[]): ChatBackendAdapter {
  return {
    systemId: 'hermes',
    async health() { return { ok: true, mode: 'mock', detail: 'progress sanitizer fixture' }; },
    async *streamReply() {
      for (const item of items) yield item;
    },
  };
}

describe('progress status sanitization', () => {
  it('preserves benign human-readable progress', () => {
    expect(sanitizeProgressStatus('Hermes 연결 중')).toBe('Hermes 연결 중');
  });

  it('collapses control characters and bounds progress length', () => {
    const status = sanitizeProgressStatus(`첫 단계\n\t${'x'.repeat(500)}`);
    expect(status).not.toMatch(/[\r\n\t]/);
    expect(status.length).toBeLessThanOrEqual(MAX_PROGRESS_STATUS_LENGTH);
    expect(status.endsWith('…')).toBe(true);
  });

  it('redacts bearer, authorization, prefixed named secrets, and arbitrary absolute private paths', () => {
    const status = sanitizeProgressStatus(
      'connecting LETTA_API_KEY=super-secret CF_ACCESS_CLIENT_SECRET=cloudflare-secret path=/data/artifacts/private/config.json workspace=/workspace/private C:\\custom\\tei\\secret.txt',
    );
    expect(status).not.toContain('super-secret');
    expect(status).not.toContain('cloudflare-secret');
    expect(status).not.toContain('/data/artifacts');
    expect(status).not.toContain('/workspace/private');
    expect(status).not.toContain('C:\\custom\\tei');
    expect(status).toContain('LETTA_API_KEY=[redacted]');
    expect(status).toContain('CF_ACCESS_CLIENT_SECRET=[redacted]');
    expect(status).toContain('path=[path]');
    expect(status).toContain('workspace=[path]');
  });

  it('redacts bare and prefixed named secret labels', () => {
    const status = sanitizeProgressStatus(
      'password=hunter2 token=customer-secret api_key=abcdefghijk LETTA_API_KEY=super-secret',
    );
    expect(status).not.toContain('hunter2');
    expect(status).not.toContain('customer-secret');
    expect(status).not.toContain('abcdefghijk');
    expect(status).not.toContain('super-secret');
    expect(status).toContain('password=[redacted]');
    expect(status).toContain('token=[redacted]');
    expect(status).toContain('api_key=[redacted]');
    expect(status).toContain('LETTA_API_KEY=[redacted]');
  });

  it('redacts the complete remainder of comma-delimited authorization values', () => {
    const status = sanitizeProgressStatus(
      'auth Authorization: AWS4-HMAC-SHA256 Credential=abc, SignedHeaders=host, Signature=secret',
    );
    expect(status).toBe('auth Authorization=[redacted]');
    expect(status).not.toContain('Credential=abc');
    expect(status).not.toContain('Signature=secret');
  });

  it('redacts quoted, punctuation-wrapped Unix paths and Windows UNC paths', () => {
    const status = sanitizeProgressStatus(
      'Reading "/data/artifacts/private/config.json" then Opening (/workspace/private/file.txt) and [`/srv/private/a.txt`] then \\\\server\\share\\private.txt',
    );
    expect(status).not.toContain('/data/artifacts/private/config.json');
    expect(status).not.toContain('/workspace/private/file.txt');
    expect(status).not.toContain('/srv/private/a.txt');
    expect(status).not.toContain('\\\\server\\share\\private.txt');
    expect(status.match(/\[path\]/g)?.length).toBe(4);
  });

  it('does not mistake an https URL for an absolute filesystem path', () => {
    expect(sanitizeProgressStatus('Checking https://chat.ailucy.online health')).toBe(
      'Checking https://chat.ailucy.online health',
    );
  });

  it('replaces JSON and textual tool argument blobs with a bounded generic progress label', () => {
    expect(sanitizeProgressStatus('tool=exec args={"command":"cat /etc/passwd","token":"secret"}'))
      .toBe('도구 실행 중');
    expect(sanitizeProgressStatus('{"arguments":{"path":"/root/private","password":"secret"}}'))
      .toBe('도구 실행 중');
    expect(sanitizeProgressStatus('exec {"command":"cat /etc/passwd","query":"customer-42"}'))
      .toBe('도구 실행 중');
    expect(sanitizeProgressStatus('tool input=[{"path":"/root/private","op":"read"}]'))
      .toBe('도구 실행 중');
    expect(sanitizeProgressStatus('tool=exec command=cat ./data/private.txt'))
      .toBe('도구 실행 중');
    expect(sanitizeProgressStatus('tool call search(query=customer-private-info)'))
      .toBe('도구 실행 중');
    expect(sanitizeProgressStatus('tool call search query=customer-private-info'))
      .toBe('도구 실행 중');
  });

  it('sanitizes status events before downstream consumers while preserving other stream items', async () => {
    const adapter = wrapProgressSanitizer(fakeAdapter([
      { type: 'status', status: 'exec input={"command":"cat /root/private"}' },
      { type: 'delta', delta: '사용자 응답' },
    ]));
    const items: AdapterStreamItem[] = [];
    for await (const item of adapter.streamReply({} as never)) items.push(item);
    expect(items).toEqual([
      { type: 'status', status: '도구 실행 중' },
      { type: 'delta', delta: '사용자 응답' },
    ]);
  });
});
