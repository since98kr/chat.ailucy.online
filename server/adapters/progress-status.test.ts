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

  it('redacts bearer tokens, named secrets, and private paths', () => {
    const status = sanitizeProgressStatus(
      'connecting Authorization: Bearer abcdefghijklmnop api_key=super-secret /home/since98kr/private/config.json C:\\Users\\tei\\secret.txt',
    );
    expect(status).not.toContain('abcdefghijklmnop');
    expect(status).not.toContain('super-secret');
    expect(status).not.toContain('/home/since98kr');
    expect(status).not.toContain('C:\\Users\\tei');
    expect(status).toContain('[redacted]');
    expect(status).toContain('[path]');
  });

  it('replaces raw tool argument blobs with a bounded generic progress label', () => {
    expect(sanitizeProgressStatus('tool=exec args={"command":"cat /etc/passwd","token":"secret"}'))
      .toBe('도구 실행 중');
    expect(sanitizeProgressStatus('{"arguments":{"path":"/root/private","password":"secret"}}'))
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
