#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const write = process.argv.includes('--write');
const bridgePath = resolve('ops/letta-bridge/letta-cli-bridge.mjs');
const bridgeTestPath = resolve('ops/letta-bridge/letta-side-effect-tool-proof.nodecheck.mjs');
const e2ePath = resolve('e2e-staging/letta-full-runtime.spec.ts');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceRange(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

async function transform(path, apply) {
  const input = await readFile(path, 'utf8');
  const output = apply(input);
  if (output === input) throw new Error(`No change produced for ${path}`);
  if (write) await writeFile(path, output);
}

const probeBlock = `export async function createToolProbe() {
  const id = randomUUID().replaceAll('-', '');
  const token = randomUUID().replaceAll('-', '');
  const probe = {
    id,
    token,
    url: '',
    command: '',
    observed: false,
    runningEmitted: false,
    completedEmitted: false,
    server: null,
    onObserved: null,
  };
  const server = createServer((request, response) => {
    const remoteAddress = String(request.socket.remoteAddress || '');
    if (!LOOPBACK_ADDRESSES.has(remoteAddress)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/' + id) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > TOOL_PROBE_MAX_BODY_BYTES) oversized = true;
      else chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (oversized) {
        response.writeHead(413).end();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (body !== token) {
        response.writeHead(403).end();
        return;
      }
      if (!probe.observed) {
        probe.observed = true;
        probe.onObserved?.();
      }
      response.writeHead(204).end();
    });
    request.on('error', () => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  probe.server = server;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', () => {});
  server.unref?.();
  const address = server.address();
  if (!address || typeof address === 'string') {
    cleanupToolProbe(probe);
    throw new Error('Could not allocate the local tool proof endpoint');
  }
  probe.url = 'http://127.0.0.1:' + address.port + '/' + id;
  probe.command = "/usr/bin/curl --fail --silent --show-error --max-time 10 --request POST --header 'Content-Type: text/plain' --data-binary '" + token + "' '" + probe.url + "'";
  return probe;
}

export function observeToolProbe(probe) {
  return probe?.observed === true;
}

export function cleanupToolProbe(probe) {
  if (!probe) return;
  probe.onObserved = null;
  try {
    probe.server?.closeAllConnections?.();
    probe.server?.close();
  } catch {
    // The listener is loopback-only and best-effort cleanup also runs on session shutdown.
  }
  probe.server = null;
}

export function redactToolProbeText(value, probe) {
  if (typeof value !== 'string' || !probe) return value;
  return value.split(probe.url).join('[tool-probe-url-redacted]')
    .split(probe.token).join('[tool-probe-token-redacted]')
    .split(probe.id).join('[tool-probe-id-redacted]');
}

function toolProbeInstructions(probe) {
  const payload = JSON.stringify({ url: probe.url, token: probe.token, command: probe.command });
  return [
    '<CHAT_V2_LOCAL_TOOL_PROBE>',
    'This is an automated proof of real local CLI tool execution.',
    'Before producing any assistant text, invoke the advertised Bash tool and run the exact command from the JSON payload without changing or simulating it.',
    'The command performs one harmless POST to a bridge-owned loopback endpoint. A textual claim is not accepted as proof.',
    'Do not mention or reproduce the URL, token, command, port, or callback identifier in your answer.',
    'CHAT_V2_PROBE_JSON=' + payload,
    '</CHAT_V2_LOCAL_TOOL_PROBE>',
  ].join('\\n');
}

`;

await transform(bridgePath, (input) => {
  let source = input;
  source = replaceOnce(source,
    "import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';",
    "import { readFileSync } from 'node:fs';",
    'filesystem probe imports');
  source = replaceOnce(source,
    "const TOOL_PROBE_STATUS = 'filesystem_probe';",
    "const TOOL_PROBE_STATUS = 'loopback_callback_probe';\nconst TOOL_PROBE_MAX_BODY_BYTES = 128;\nconst LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);",
    'probe constants');
  source = replaceRange(source,
    'export function createToolProbe(root) {',
    'function capsuleBlock(capsules) {',
    probeBlock,
    'filesystem probe implementation');
  source = replaceOnce(source,
    "this.completePending(new Error('Lucy CLI runtime did not complete the verified local tool probe'));",
    "this.completePending(new Error('Lucy CLI runtime did not complete the verified loopback tool probe'));",
    'probe failure message');
  source = replaceOnce(source,
    '    if (pending.probeInterval) clearInterval(pending.probeInterval);\n',
    '',
    'probe polling cleanup');
  source = replaceOnce(source,
    '    const probe = toolProbeRequested(current) ? createToolProbe(this.config.cwd) : null;',
    '    const probe = toolProbeRequested(current) ? await createToolProbe() : null;',
    'probe creation');
  source = replaceOnce(source,
    '        probe, probeInterval: null,',
    '        probe,',
    'pending probe shape');
  source = replaceRange(source,
    '      if (probe) {\n        const observe = () => {',
    '      signal?.addEventListener',
`      if (probe) {
        probe.onObserved = () => {
          if (this.pending !== pending || probe.runningEmitted) return;
          probe.runningEmitted = true;
          pending.onItem({ status: 'tool.running:' + TOOL_PROBE_STATUS });
        };
      }
`,
    'probe observation wiring');
  return source;
});

const testContent = `import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupToolProbe,
  createBridgeServer,
  createToolProbe,
  observeToolProbe,
} from './letta-cli-bridge.mjs';

function runtimeConfig(cwd, fixture) {
  return {
    host: '127.0.0.1', port: 0, token: 'secret', agentId: 'agent-test', command: process.execPath,
    cwd, backend: 'local', maxSessions: 2, idleMs: 60_000, requestTimeoutMs: 5_000,
    maxBodyBytes: 100_000, memfsStartup: '', extraArgs: [], runtimeModelId: '',
    requireModel: true, requireTools: true, requireSkillSources: true, requireMcpServers: true,
    requireSlashCommands: true, requireMemfs: true, requiredTools: [], requiredSkillSources: [],
    requiredMcpServers: [], requiredSlashCommands: [], spawnArgs: [fixture],
  };
}

test('loopback proof accepts only an exact bounded POST and closes cleanly', async (t) => {
  const exact = await createToolProbe();
  t.after(() => cleanupToolProbe(exact));
  assert.match(exact.url, /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/[0-9a-f]{32}$/);
  assert.equal((await fetch(exact.url, { method: 'GET' })).status, 404);
  assert.equal((await fetch(exact.url, { method: 'POST', body: 'wrong-token' })).status, 403);
  assert.equal(observeToolProbe(exact), false);
  assert.equal((await fetch(exact.url, { method: 'POST', body: exact.token })).status, 204);
  assert.equal(observeToolProbe(exact), true);

  const oversized = await createToolProbe();
  t.after(() => cleanupToolProbe(oversized));
  assert.equal((await fetch(oversized.url, { method: 'POST', body: 'x'.repeat(129) })).status, 413);
  assert.equal(observeToolProbe(oversized), false);
});

test('bridge emits running then completed only after a real loopback Bash side effect', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-loopback-fixture-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  await writeFile(fixture, \\`
    import { createInterface } from 'node:readline';
    console.log(JSON.stringify({
      type: 'system', subtype: 'init', agent_id: 'agent-test', conversation_id: 'conversation-test', session_id: 'session-test',
      model: 'openai/gpt-5.6', tools: ['Bash'], cwd: process.cwd(), mcp_servers: [],
      permission_mode: 'unrestricted', slash_commands: [], memfs_enabled: true,
      skill_sources: ['bundled', 'global', 'agent', 'project']
    }));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const input = JSON.parse(line);
      if (input.type !== 'user') continue;
      const prefix = 'CHAT_V2_PROBE_JSON=';
      const payloadLine = input.message.content.split('\\\\n').find((item) => item.startsWith(prefix));
      if (!payloadLine) throw new Error('probe payload missing');
      const probe = JSON.parse(payloadLine.slice(prefix.length));
      await fetch(probe.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: probe.token });
      const output = 'MODEL=openai/gpt-5.6 URL=' + probe.url + ' TOKEN=' + probe.token;
      console.log(JSON.stringify({ type: 'stream_event', event: { message_type: 'assistant_message', content: [{ type: 'text', text: output }] } }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: output }));
    }
  \\`);

  const { server } = createBridgeServer(runtimeConfig(fixtureDir, fixture));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const address = server.address();
  const response = await fetch(\`http://127.0.0.1:\${address.port}/v1/chat/stream\`, {
    method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: 'conversation-1', agent_id: 'agent-test', messages: [{
      role: 'user', content: '<CHAT_V2_VERIFY_LOCAL_TOOL> Verify a real local tool execution.', message_id: 'message-1',
    }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const items = body.trim().split('\\n').map(JSON.parse);
  const statuses = items.map((item) => item.status).filter(Boolean);
  assert.ok(statuses.indexOf('tool.running:loopback_callback_probe') >= 0);
  assert.ok(statuses.indexOf('tool.completed:loopback_callback_probe') > statuses.indexOf('tool.running:loopback_callback_probe'));
  assert.doesNotMatch(body, /127\\.0\\.0\\.1:\\d+\\/[0-9a-f]{32}|[0-9a-f]{32}/i);
  assert.match(body, /tool-probe-url-redacted/);
  assert.match(body, /tool-probe-token-redacted/);
});

test('bridge fails closed when the runtime claims success without a callback', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-loopback-missing-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  await writeFile(fixture, \\`
    import { createInterface } from 'node:readline';
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'openai/gpt-5.6', tools: ['Bash'],
      mcp_servers: [], permission_mode: 'unrestricted', slash_commands: [], memfs_enabled: true,
      skill_sources: ['bundled', 'global', 'agent', 'project'] }));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (JSON.parse(line).type === 'user') console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'claimed success' }));
    }
  \\`);
  const { server } = createBridgeServer(runtimeConfig(fixtureDir, fixture));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const address = server.address();
  const response = await fetch(\`http://127.0.0.1:\${address.port}/v1/chat/stream\`, {
    method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: 'conversation-2', agent_id: 'agent-test', messages: [{
      role: 'user', content: '<CHAT_V2_VERIFY_LOCAL_TOOL> Verify.', message_id: 'message-2',
    }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /verified loopback tool probe/);
  assert.doesNotMatch(body, /tool\\.completed:loopback_callback_probe/);
});
`;

await transform(bridgeTestPath, () => testContent);

await transform(e2ePath, (input) => {
  let source = input.replaceAll('tool.running:filesystem_probe', 'tool.running:loopback_callback_probe')
    .replaceAll('tool.completed:filesystem_probe', 'tool.completed:loopback_callback_probe');
  source = replaceOnce(source,
    '/chat-v2-letta-tool-probes|tool-probe-path|tool-probe-token/i',
    '/tool-probe-url|tool-probe-token|loopback_callback_probe.*127\\.0\\.0\\.1/i',
    'E2E callback redaction assertion');
  return source;
});

if (!write) console.log('Loopback local-tool proof patch validated.');
