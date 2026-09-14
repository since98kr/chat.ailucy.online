import { describe, expect, it } from 'vitest';
import { sanitizeProgressStatus } from './progress-status.js';

describe('progress sanitizer fresh-review regressions', () => {
  it('fails closed on common password aliases in fields and URLs', () => {
    expect(sanitizeProgressStatus('passwd=customer-secret')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('pwd=customer-secret')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('Checking https://example.test/?passwd=customer-secret')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('Checking https://example.test/?pwd=customer-secret')).toBe('작업 진행 중');
  });

  it('collapses tool payloads even when a quoted tool identifier exceeds the preservation bound', () => {
    const overlongToolName = 'x'.repeat(161);
    expect(sanitizeProgressStatus(`tool="${overlongToolName}" query=secret-info`)).toBe('도구 실행 중');
    expect(sanitizeProgressStatus(`tool call "${overlongToolName}" customer-private-info`)).toBe('도구 실행 중');
  });

  it('treats angle brackets as presentation boundaries around relative private paths', () => {
    expect(sanitizeProgressStatus('Reading <customer/private/config.json>')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('Reading <customer\\private\\config.json>')).toBe('작업 진행 중');
  });
});
