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
  it('preserves benign human-readable progress and bounds normalized output', () => {
    expect(sanitizeProgressStatus('Hermes 연결 중')).toBe('Hermes 연결 중');
    const status = sanitizeProgressStatus(`첫 단계\n\t${'x'.repeat(500)}`);
    expect(status).not.toMatch(/[\r\n\t]/);
    expect(status.length).toBeLessThanOrEqual(MAX_PROGRESS_STATUS_LENGTH);
    expect(status.endsWith('…')).toBe(true);
  });

  it('preserves the documented bounded native bridge lifecycle states after label taint checks', () => {
    const safe = [
      'tool.approval_required:web search',
      'tool.approved:mcp/search',
      'tool.running:hmac_challenge_probe',
      'tool.completed:hmac_challenge_probe',
      'tool.failed:hmac_challenge_probe',
    ];
    for (const input of safe) expect(sanitizeProgressStatus(input), input).toBe(input);
    expect(sanitizeProgressStatus('tool.running:sk-proj_abcdefghijklmnop')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('tool.running:Bearer abcdefghijklmnop')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('tool.running:Basic dXNlcjpwYXNz')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('tool.running:Basic YTpi')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('tool.running:Authorization: Basic abcdefghijklmnop')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('running:customer-private-info')).toBe('작업 진행 중');
    expect(sanitizeProgressStatus('tool.running:../../private')).toBe('작업 진행 중');

    const maxApproval = sanitizeProgressStatus(`tool.approval_required:${'m'.repeat(160)}`);
    expect(maxApproval.length).toBeLessThanOrEqual(MAX_PROGRESS_STATUS_LENGTH);
    expect(maxApproval.endsWith('…')).toBe(true);
  });

  it('preserves only the documented bounded native bridge runtime evidence grammar', () => {
    const safe = [
      'runtime.model:openai/gpt-5.6-terra',
      'runtime.permission:unrestricted',
      'runtime.permission:standard',
      'runtime.permission:acceptEdits',
      'runtime.permission:strict',
      'runtime.permission:unknown',
      'runtime.mcp_advertised:true',
      'runtime.slash_commands_advertised:false',
      'runtime.capabilities:tools=12;skill_sources=3;mcp=0;commands=4;memfs=true',
      `runtime.model:${'m'.repeat(160)}`,
    ];
    for (const input of safe) expect(sanitizeProgressStatus(input), input).toBe(input);

    const unsafe = [
      'runtime.model:sk-proj_abcdefghijklmnop',
      'runtime.model:Bearer abcdefghijklmnop',
      'runtime.model:Basic dXNlcjpwYXNz',
      'runtime.model:Basic YTpi',
      'runtime.model:Authorization: Basic abcdefghijklmnop',
      'runtime.model:../../private',
      `runtime.model:${'m'.repeat(161)}`,
      'runtime.permission:bypassPermissions',
      'runtime.permission:customer-private-info',
      'runtime.permission:../../private',
      'runtime.mcp_advertised:yes',
      'runtime.capabilities:tools=12;skill_sources=3;mcp=0;commands=4;memfs=true;token=secret',
      'runtime.unknown:customer-private-info',
    ];
    for (const input of unsafe) expect(sanitizeProgressStatus(input), input).toBe('작업 진행 중');
  });

  it('fails closed for credential-bearing and non-http URI progress', () => {
    const cases = [
      'Authorization: AWS4-HMAC-SHA256 Credential=abc, SignedHeaders=host, Signature=secret',
      'Cookie: theme=dark; sessionid=customer-secret',
      'Bearer abcdefghijklmnop',
      'Basic dXNlcjpwYXNz',
      'Basic YTpi',
      'Connecting with Basic YTpi.',
      'token=customer-secret',
      'password=abc;def',
      'LETTA_API_KEY=super-secret',
      'CF_ACCESS_CLIENT_SECRET=cloudflare-secret',
      'API_SERVER_KEY=hermes-key',
      'LETTA_SSH_PRIVATE_KEY=private-key-material',
      'apiKey=camel-api',
      'clientSecret=camel-secret',
      'accessToken=camel-token',
      'APIKey=upper-secret',
      'clientAPIKey=client-upper-secret',
      'APIKEY=all-upper-secret',
      'apikey=all-lower-secret',
      'sk-proj_abcdefghijklmnop',
      'Checking https://alice:pa,ss@example.test/private',
      'Checking https://example.test/?sessionid=customer-secret',
      'Checking https://example.test/?token=abc,def&next=/home',
      'Checking https://example.test/?APIKey=abc;def&next=/home',
      'Checking https://example.test/?%74oken=encoded-secret&next=/home',
      'Checking https://example.test/?%74oken%ZZ=malformed-secret&next=/home',
      'Checking https://example.test/#%61ccessToken=fragment-secret',
      'Checking https://example.test/#/callback?%73essionid=customer-secret',
      'Checking https://example.test/?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeef',
      'Connecting postgres://alice:p%40ss@db.example/customer',
      'Connecting redis://cache.internal/0',
      'Reading s3://private-bucket/customer/data.json',
      'Loading data:text/plain,customer-private-info',
      'Fetching blob:https://example.test/private-object-id',
    ];
    for (const input of cases) {
      expect(sanitizeProgressStatus(input), input).toBe('작업 진행 중');
    }
  });

  it('fails closed for private paths across punctuation, unicode, and path syntaxes', () => {
    const cases = [
      'Reading /data/artifacts/private/config.json',
      'Reading /data/customer,private/config.txt',
      'Reading /data/customer;private/config.txt',
      'Reading /data/customer secrets/private key.txt',
      'Reading /고객/비밀.txt',
      'Reading /고객 자료/비밀 파일.txt',
      'Reading customer/private/config.json',
      'Reading customer\\private\\config.json',
      'Reading "customer/private/config.json"',
      "Reading 'customer\\private\\config.json'",
      'Reading \\Users\\tei\\private.txt',
      'path:/data/artifacts/private/config.json',
      'Opening (/workspace/private/file.txt)',
      'Opening [`/srv/private/a.txt`]',
      'C:/Users/tei/private.txt',
      'C:\\Users\\tei\\private.txt',
      '\\\\server\\share\\private.txt',
      '//forward/share/private.txt',
      'file:///data/customer/private.txt',
      'path://server/share/private.txt',
      'Reading ./data/private.txt',
      'Reading ../private/config.txt',
      'source=https://example.test,target=/data/artifacts/private/config.json',
      'source=https://example.test;target:/data/artifacts/private/config.json',
      'source=https://example.test&target=/data/private/config.json',
      'source=https://example.test/?ok=1,target=/data/private/config.json',
    ];
    for (const input of cases) {
      expect(sanitizeProgressStatus(input), input).toBe('작업 진행 중');
    }
  });

  it('preserves complete benign http URLs including path-like query, semicolon parameters, ampersand parameters, and hash portions', () => {
    expect(sanitizeProgressStatus('Checking https://chat.ailucy.online health')).toBe(
      'Checking https://chat.ailucy.online health',
    );
    expect(sanitizeProgressStatus('Checking https://example.test/callback?next=/private/dashboard')).toBe(
      'Checking https://example.test/callback?next=/private/dashboard',
    );
    expect(sanitizeProgressStatus('Checking https://example.test/callback?mode=x;next=/private/dashboard')).toBe(
      'Checking https://example.test/callback?mode=x;next=/private/dashboard',
    );
    expect(sanitizeProgressStatus('Checking https://example.test/callback?mode=x&target=/public/dashboard')).toBe(
      'Checking https://example.test/callback?mode=x&target=/public/dashboard',
    );
    expect(sanitizeProgressStatus('Checking https://example.test/#/settings')).toBe(
      'Checking https://example.test/#/settings',
    );
    expect(sanitizeProgressStatus('Checking https://example.test/#/callback?next=/public/dashboard')).toBe(
      'Checking https://example.test/#/callback?next=/public/dashboard',
    );
  });

  it('collapses JSON, positional, flag, attached structured, quoted-id, and arbitrary textual tool argument variants to a generic tool label', () => {
    const cases = [
      'tool=exec args={"command":"cat /etc/passwd","token":"secret"}',
      '{"arguments":{"path":"/root/private","password":"secret"}}',
      'exec {"command":"cat /etc/passwd","query":"customer-42"}',
      'tool input=[{"path":"/root/private","op":"read"}]',
      'tool=exec command=cat ./data/private.txt',
      'tool=search,query=customer-private-info',
      'tool="search",query=customer-private-info',
      'tool="web search",query=customer-private-info',
      'tool="mcp/search",query=customer-private-info',
      'tool="검색",query=customer-private-info',
      'tool=검색 query=customer-private-info',
      "tool_name='exec' command=customer-private-info",
      "tool_name='검색' command=customer-private-info",
      'tool=search q=customer-private-info',
      'tool=fetch url=https://example.test/private',
      'tool=render prompt=customer-private-info',
      'tool=search ["customer-private-info"]',
      'tool=search["customer-private-info"]',
      'tool=search{"query":"customer-private-info"}',
      'tool=search customer-private-info',
      'tool call search --query customer-private-info',
      'tool call "search" query=customer-private-info',
      'tool call "web search" query=customer-private-info',
      'tool call "검색" query=customer-private-info',
      'tool call 검색 customer-private-info',
      'tool call search "customer-private-info"',
      'tool call search customer-private-info',
      'tool call search(query=customer-private-info)',
      'tool call search q=customer-private-info',
      'tool call search query=customer-private-info',
      'tool call: search query=customer-private-info',
      'tool_call search url=https://example.test/private',
      'tool call search with query=customer-private-info',
      'tool call search with the query=customer-private-info',
      'tool call exec using the provided arguments={"command":"cat /private"}',
    ];
    for (const input of cases) {
      expect(sanitizeProgressStatus(input), input).toBe('도구 실행 중');
    }
  });

  it('does not collapse a tool marker that carries no raw argument payload', () => {
    expect(sanitizeProgressStatus('tool=search ready')).toBe('tool=search ready');
    expect(sanitizeProgressStatus('tool="search" ready')).toBe('tool="search" ready');
    expect(sanitizeProgressStatus('tool="web search" ready')).toBe('tool="web search" ready');
    expect(sanitizeProgressStatus('tool="검색" ready')).toBe('tool="검색" ready');
    expect(sanitizeProgressStatus('tool=검색 ready')).toBe('tool=검색 ready');
    expect(sanitizeProgressStatus('tool call search completed')).toBe('tool call search completed');
  });

  it('sanitizes status events before downstream consumers while preserving non-status items', async () => {
    const adapter = wrapProgressSanitizer(fakeAdapter([
      { type: 'status', status: 'password=abc;def' },
      { type: 'delta', delta: '사용자 응답' },
    ]));
    const items: AdapterStreamItem[] = [];
    for await (const item of adapter.streamReply({} as never)) items.push(item);
    expect(items).toEqual([
      { type: 'status', status: '작업 진행 중' },
      { type: 'delta', delta: '사용자 응답' },
    ]);
  });
});
