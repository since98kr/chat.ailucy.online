#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const write = process.argv.includes('--write');
const bridgePath = resolve('ops/letta-bridge/letta-cli-bridge.mjs');
const bridgeTestPath = resolve('ops/letta-bridge/letta-side-effect-tool-proof.nodecheck.mjs');
const httpPath = resolve('server/adapters/http.ts');
const httpTestPath = resolve('server/adapters/http.test.ts');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

async function transform(path, apply) {
  const input = await readFile(path, 'utf8');
  const output = apply(input);
  if (output === input) throw new Error(`No change produced for ${path}`);
  if (write) await writeFile(path, output);
}

await transform(bridgePath, (input) => {
  let source = input;
  source = replaceOnce(source,
    "import { tmpdir } from 'node:os';\n",
    '',
    'obsolete tmpdir import');
  source = replaceOnce(source,
    "const TOOL_PROBE_ROOT = join(tmpdir(), 'chat-v2-letta-tool-probes');\n",
    '',
    'obsolete probe root');
  source = replaceOnce(source,
`export function createToolProbe() {
  mkdirSync(TOOL_PROBE_ROOT, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const token = randomUUID().replaceAll('-', '');
  const path = join(TOOL_PROBE_ROOT, id + '.txt');
  rmSync(path, { force: true });
  return { path, token, observed: false, runningEmitted: false, completedEmitted: false };
}`,
`export function createToolProbe(root) {
  const base = resolvePath(root || process.cwd());
  const id = randomUUID();
  const token = randomUUID().replaceAll('-', '');
  const path = join(base, '.chat-v2-tool-probe-' + id + '.txt');
  rmSync(path, { recursive: true, force: true });
  return { path, token, observed: false, runningEmitted: false, completedEmitted: false };
}`,
    'workspace probe factory');
  source = replaceOnce(source,
    "    'Use an advertised local tool such as Write or Bash to create a regular UTF-8 file at the exact path in the JSON payload.',\n    'The file must contain exactly the token and no other text. Then use an advertised local read tool to read it back before answering.',",
    "    'Use the advertised Bash tool to create a regular UTF-8 file at the exact path in the JSON payload. Write exactly the token with no trailing newline.',\n    'Then use the advertised Read tool to read the same file back before answering.',",
    'explicit Bash and Read instructions');
  source = replaceOnce(source,
    'const probe = toolProbeRequested(current) ? createToolProbe() : null;',
    'const probe = toolProbeRequested(current) ? createToolProbe(this.config.cwd) : null;',
    'workspace probe call');
  return source;
});

await transform(bridgeTestPath, (input) => {
  let source = input.replaceAll('createToolProbe();', 'createToolProbe(root);');
  source = replaceOnce(source,
`  const exact = createToolProbe(root);
  t.after(() => cleanupToolProbe(exact));`,
`  const exact = createToolProbe(root);
  assert.equal(exact.path.startsWith(root + '/.chat-v2-tool-probe-'), true);
  t.after(() => cleanupToolProbe(exact));`,
    'workspace probe assertion');
  return source;
});

await transform(httpPath, (input) => {
  const helper = `function backendStreamError(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>).error;
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof (value as Record<string, unknown>).message === 'string'
      ? String((value as Record<string, unknown>).message)
      : '';
  const sanitized = raw.replace(/[\\u0000-\\u001f\\u007f]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 500);
  return sanitized || null;
}

`;
  let source = replaceOnce(input,
    'function processPayload(\n',
    helper + 'function processPayload(\n',
    'backend error helper insertion');
  source = replaceOnce(source,
`): AdapterStreamItem[] {
  toolAccumulator.ingest(payload);`,
`): AdapterStreamItem[] {
  const backendError = backendStreamError(payload);
  if (backendError) throw new Error(\`Backend stream error: \${backendError}\`);
  toolAccumulator.ingest(payload);`,
    'backend error propagation');
  return source;
});

await transform(httpTestPath, (input) => {
  const insertion = `

  it('fails closed on JSON, NDJSON, and SSE backend error frames', async () => {
    const baseUrl = await startServer((request, response) => {
      if (request.url === '/ndjson') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write('{"status":"runtime.model:gpt-5.6-terra"}\\n');
        response.end('{"error":"verified local tool probe failed"}\\n');
        return;
      }
      if (request.url === '/sse') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"error":{"message":"verified local tool probe failed"}}\\n\\n');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"error":"verified local tool probe failed"}');
    });

    const lettaConversation = { ...conversation, systemId: 'letta' as const, agentId: '[Letta] Lucy' };
    const lettaParticipant = {
      ...participants[0],
      conversationId: lettaConversation.id,
      agentId: '[Letta] Lucy',
      agent: {
        ...participants[0].agent,
        id: '[Letta] Lucy',
        systemId: 'letta' as const,
        displayName: '[Letta] Lucy',
      },
    };

    for (const chatPath of ['/json', '/ndjson', '/sse']) {
      const adapter = new HttpAgentAdapter('letta', {
        baseUrl,
        chatPath,
        healthPath: '/health',
        timeoutMs: 2_000,
      });
      const items = [];
      const consume = async () => {
        for await (const item of adapter.streamReply({
          conversation: lettaConversation,
          userMessage: { ...userMessage, conversationId: lettaConversation.id },
          history: [{ ...userMessage, conversationId: lettaConversation.id }],
          targetAgentId: '[Letta] Lucy',
          routingMode: 'direct',
          participants: [lettaParticipant],
        })) items.push(item);
      };
      await expect(consume()).rejects.toThrow('Backend stream error: verified local tool probe failed');
      expect(items.every((item) => item.type !== 'delta')).toBe(true);
    }
  });`;
  return replaceOnce(input,
    '\n});\n\ntype OpenAiTestPart = {',
    insertion + '\n});\n\ntype OpenAiTestPart = {',
    'HTTP error-frame regression test');
});

if (!write) {
  console.log('Workspace probe and backend error propagation patch validated.');
}
