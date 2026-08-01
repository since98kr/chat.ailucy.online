import test from 'node:test';
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

test('loopback proof accepts only an exact bounded POST and closes cleanly', async (t) => {
  const exact = await createToolProbe();
  t.after(() => cleanupToolProbe(exact));
  assert.match(exact.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
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

test('bridge emits running then completed only after a real loopback tool side effect', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-loopback-fixture-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  await writeFile(fixture, `
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
      const payloadLine = input.message.content.split('\\n').find((item) => item.startsWith(prefix));
      if (!payloadLine) throw new Error('probe payload missing');
      const probe = JSON.parse(payloadLine.slice(prefix.length));
      await fetch(probe.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: probe.token });
      const output = 'MODEL=openai/gpt-5.6 URL=' + probe.url + ' TOKEN=' + probe.token;
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
  assert.ok(statuses.indexOf('tool.running:loopback_callback_probe') >= 0);
  assert.ok(statuses.indexOf('tool.completed:loopback_callback_probe') > statuses.indexOf('tool.running:loopback_callback_probe'));
  assert.doesNotMatch(body, /127\.0\.0\.1:\d+\/[0-9a-f]{32}|[0-9a-f]{32}/i);
  assert.match(body, /tool-probe-url-redacted/);
  assert.match(body, /tool-probe-token-redacted/);
});

test('bridge fails closed when the runtime claims success without a callback', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-loopback-missing-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  await writeFile(fixture, `
    import { createInterface } from 'node:readline';
    console.log(JSON.stringify({
      type: 'system', subtype: 'init', model: 'openai/gpt-5.6', tools: ['Bash'],
      mcp_servers: [], permission_mode: 'unrestricted', slash_commands: [], memfs_enabled: true,
      skill_sources: ['bundled', 'global', 'agent', 'project']
    }));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (JSON.parse(line).type === 'user') {
        console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'claimed success' }));
      }
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
      conversation_id: 'conversation-2',
      agent_id: 'agent-test',
      messages: [{ role: 'user', content: '<CHAT_V2_VERIFY_LOCAL_TOOL> Verify.', message_id: 'message-2' }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /verified loopback tool probe/);
  assert.doesNotMatch(body, /tool\.completed:loopback_callback_probe/);
});
