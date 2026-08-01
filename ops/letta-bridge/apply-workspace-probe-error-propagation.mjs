#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const write = process.argv.includes('--write');
const bridgePath = resolve('ops/letta-bridge/letta-cli-bridge.mjs');
const httpPath = resolve('server/adapters/http.ts');
const bridgeTestPath = resolve('ops/letta-bridge/letta-side-effect-tool-proof.nodecheck.mjs');
const httpTestPath = resolve('server/adapters/http.test.ts');

async function transform(path, transformFile) {
  const before = await readFile(path, 'utf8');
  const after = transformFile(before);
  if (after === before) return false;
  if (write) await writeFile(path, after);
  return true;
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one source match, found ${count}`);
  return source.replace(before, after);
}

await transform(bridgePath, (input) => {
  let source = input;
  source = source.replace("import { tmpdir } from 'node:os';\n", '');
  source = source.replace("const TOOL_PROBE_ROOT = join(tmpdir(), 'chat-v2-letta-tool-probes');\n", '');
  source = replaceOnce(source,
`export function createToolProbe() {
  mkdirSync(TOOL_PROBE_ROOT, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const token = randomUUID().replaceAll('-', '');
  const path = join(TOOL_PROBE_ROOT, id + '.txt');
  rmSync(path, { force: true });
  return { path, token, observed: false, runningEmitted: false, completedEmitted: false };
}`,
`export function createToolProbe(cwd = process.cwd()) {
  const root = resolvePath(cwd);
  const id = randomUUID();
  const token = randomUUID().replaceAll('-', '');
  const path = join(root, '.chat-v2-tool-probe-' + id + '.txt');
  rmSync(path, { recursive: true, force: true });
  return { path, token, observed: false, runningEmitted: false, completedEmitted: false };
}`,
  'workspace probe creation');
  source = replaceOnce(source,
`    'Use an advertised local tool such as Write or Bash to create a regular UTF-8 file at the exact path in the JSON payload.',
    'The file must contain exactly the token and no other text. Then use an advertised local read tool to read it back before answering.',`,
`    'Use the advertised Bash tool to create a regular UTF-8 file at the exact path in the JSON payload with exactly the token and no newline or other text.',
    'Then use an advertised local read tool such as Read to read that exact file back before answering.',`,
  'workspace tool instructions');
  source = replaceOnce(source,
    'const probe = toolProbeRequested(current) ? createToolProbe() : null;',
    'const probe = toolProbeRequested(current) ? createToolProbe(this.config.cwd) : null;',
    'workspace probe call');
  for (const required of [
    "join(root, '.chat-v2-tool-probe-' + id + '.txt')",
    'createToolProbe(this.config.cwd)',
    'Use the advertised Bash tool',
  ]) if (!source.includes(required)) throw new Error(`missing bridge contract: ${required}`);
  return source;
});

await transform(httpPath, (input) => {
  let source = input;
  source = replaceOnce(source,
`function processPayload(
  payload: unknown,
  toolAccumulator: OpenAiArtifactToolAccumulator,
): AdapterStreamItem[] {
  toolAccumulator.ingest(payload);`,
`function backendStreamError(payload: unknown) {
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

function processPayload(
  payload: unknown,
  toolAccumulator: OpenAiArtifactToolAccumulator,
): AdapterStreamItem[] {
  const backendError = backendStreamError(payload);
  if (backendError) throw new Error(`${'${'}thisSystemPlaceholder}`);
  toolAccumulator.ingest(payload);`,
  'backend error helper');
  source = source.replace("if (backendError) throw new Error(`${thisSystemPlaceholder}`);", "if (backendError) throw new Error(`Backend stream error: ${backendError}`);");
  if (!source.includes('Backend stream error: ${backendError}')) throw new Error('backend stream error throw missing');
  return source;
});

await transform(bridgeTestPath, (input) => {
  let source = input;
  source = source.replaceAll('createToolProbe();', 'createToolProbe(root);');
  source = replaceOnce(source,
`  const exact = createToolProbe(root);
  t.after(() => cleanupToolProbe(exact));`,
`  const exact = createToolProbe(root);
  assert.equal(exact.path.startsWith(root + '/.chat-v2-tool-probe-'), true);
  t.after(() => cleanupToolProbe(exact));`,
  'workspace probe assertion');
  if (!source.includes("startsWith(root + '/.chat-v2-tool-probe-')")) throw new Error('workspace path assertion missing');
  return source;
});

await transform(httpTestPath, (input) => {
  let source = input;
  const insertion = `

  it('fails closed on JSON and NDJSON backend error frames', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"status":"runtime.model:gpt-5.6-terra"}\\n');
      response.end('{"error":"Lucy CLI runtime did not complete the verified local tool probe"}\\n');
    });

    const adapter = new HttpAgentAdapter('letta', {
      baseUrl,
      chatPath: '/chat',
      healthPath: '/health',
      timeoutMs: 2_000,
    });
    const lettaConversation = { ...conversation, systemId: 'letta' as const, agentId: '[Letta] Lucy' };
    const lettaParticipant = {
      ...participants[0],
      agentId: '[Letta] Lucy',
      agent: { ...participants[0].agent, id: '[Letta] Lucy', systemId: 'letta' as const },
    };

    const consume = async () => {
      for await (const _item of adapter.streamReply({
        conversation: lettaConversation,
        userMessage: { ...userMessage, conversationId: lettaConversation.id },
        history: [{ ...userMessage, conversationId: lettaConversation.id }],
        targetAgentId: '[Letta] Lucy',
        routingMode: 'direct',
        participants: [lettaParticipant],
      })) {
        // Consume the stream until the backend error frame is encountered.
      }
    };

    await expect(consume()).rejects.toThrow('Backend stream error: Lucy CLI runtime did not complete the verified local tool probe');
  });`;
  if (!source.includes("fails closed on JSON and NDJSON backend error frames")) {
    const marker = "\n});\n\ntype OpenAiTestPart";
    if (!source.includes(marker)) throw new Error('http test insertion marker missing');
    source = source.replace(marker, `${insertion}\n});\n\ntype OpenAiTestPart`);
  }
  return source;
});

if (write) console.log('Applied workspace probe and backend error propagation.');
else console.log('Workspace probe and backend error propagation validate.');
