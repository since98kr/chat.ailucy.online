import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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
    host: '127.0.0.1',
    port: 0,
    token: 'secret',
    agentId: 'agent-test',
    command: process.execPath,
    cwd,
    backend: 'local',
    maxSessions: 2,
    idleMs: 60_000,
    requestTimeoutMs: 5_000,
    maxBodyBytes: 100_000,
    memfsStartup: '',
    extraArgs: [],
    runtimeModelId: '',
    requireModel: true,
    requireTools: true,
    requireSkillSources: true,
    requireMcpServers: true,
    requireSlashCommands: true,
    requireMemfs: true,
    requiredTools: [],
    requiredSkillSources: [],
    requiredMcpServers: [],
    requiredSlashCommands: [],
    spawnArgs: [fixture],
  };
}

test('probe accepts only a bounded exact regular file and removes malformed paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'letta-tool-proof-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const exact = createToolProbe(root);
  assert.equal(exact.path.startsWith(root + '/.chat-v2-tool-probe-'), true);
  t.after(() => cleanupToolProbe(exact));
  await writeFile(exact.path, `${exact.token}\n`, { mode: 0o600 });
  assert.equal(observeToolProbe(exact), true);

  const wrong = createToolProbe(root);
  t.after(() => cleanupToolProbe(wrong));
  await writeFile(wrong.path, 'wrong-token', { mode: 0o600 });
  assert.equal(observeToolProbe(wrong), false);

  const oversized = createToolProbe(root);
  t.after(() => cleanupToolProbe(oversized));
  await writeFile(oversized.path, 'x'.repeat(129), { mode: 0o600 });
  assert.equal(observeToolProbe(oversized), false);

  const linked = createToolProbe(root);
  t.after(() => cleanupToolProbe(linked));
  const target = join(root, 'target.txt');
  await writeFile(target, linked.token, { mode: 0o600 });
  await symlink(target, linked.path);
  assert.equal(observeToolProbe(linked), false);

  const directory = createToolProbe(root);
  await mkdir(directory.path, { mode: 0o700 });
  assert.equal(observeToolProbe(directory), false);
  cleanupToolProbe(directory);
  await assert.rejects(access(directory.path));
});

test('bridge emits running then completed only after observing a real local-tool side effect', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-side-effect-fixture-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  await writeFile(fixture, `
    import { createInterface } from 'node:readline';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { dirname } from 'node:path';
    console.log(JSON.stringify({
      type: 'system', subtype: 'init', agent_id: 'agent-test', conversation_id: 'conversation-test', session_id: 'session-test',
      model: 'openai/gpt-5.6', tools: ['Write', 'Read'], cwd: process.cwd(),
      mcp_servers: [], permission_mode: 'unrestricted', slash_commands: [], memfs_enabled: true,
      skill_sources: ['bundled', 'global', 'agent', 'project']
    }));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const input = JSON.parse(line);
      if (input.type !== 'user') continue;
      const prefix = 'CHAT_V2_PROBE_JSON=';
      const payloadLine = input.message.content.split('\\n').find((item) => item.startsWith(prefix));
      if (!payloadLine) throw new Error('probe payload missing');
      const probe = JSON.parse(payloadLine.slice(prefix.length));
      await mkdir(dirname(probe.path), { recursive: true });
      await writeFile(probe.path, probe.token, { mode: 0o600 });
      const output = 'MODEL=openai/gpt-5.6 PATH=' + probe.path + ' TOKEN=' + probe.token;
      console.log(JSON.stringify({ type: 'stream_event', event: { message_type: 'assistant_message', content: [{ type: 'text', text: output }] } }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: output }));
    }
  `);

  const { server } = createBridgeServer(runtimeConfig(fixtureDir, fixture));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/stream`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: 'conversation-1',
      agent_id: 'agent-test',
      messages: [{
        role: 'user',
        content: '<CHAT_V2_VERIFY_LOCAL_TOOL> Verify a real local tool execution.',
        message_id: 'message-1',
      }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const items = body.trim().split('\n').map(JSON.parse);
  const statuses = items.map((item) => item.status).filter(Boolean);
  assert.ok(statuses.indexOf('tool.running:filesystem_probe') >= 0);
  assert.ok(statuses.indexOf('tool.completed:filesystem_probe') > statuses.indexOf('tool.running:filesystem_probe'));
  assert.doesNotMatch(body, /chat-v2-letta-tool-probes|[0-9a-f]{32}/i);
  assert.match(body, /tool-probe-path-redacted/);
  assert.match(body, /tool-probe-token-redacted/);
});
