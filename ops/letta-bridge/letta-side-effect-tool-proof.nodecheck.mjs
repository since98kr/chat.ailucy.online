import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupToolProbe,
  createBridgeServer,
  createToolProbe,
  observeToolProbe,
  toolProbeDiagnostic,
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

test('HMAC proof uses an absolute Node executable and accepts only the exact lowercase result', () => {
  const secret = 'a'.repeat(64);
  const probe = createToolProbe(secret);
  assert.equal(probe.command.includes(secret), false);
  assert.equal(probe.command.includes(probe.challenge), true);
  assert.equal(probe.command.startsWith(`${JSON.stringify(process.execPath)} -e `), true);

  const stdout = execFileSync('/bin/bash', ['-c', probe.command], {
    env: {
      ...process.env,
      PATH: '/definitely-not-a-real-path',
      CHAT_V2_TOOL_PROBE_SECRET: secret,
    },
    encoding: 'utf8',
  });
  assert.equal(stdout, probe.expected);

  assert.equal(observeToolProbe(probe, 'claimed success'), false);
  assert.equal(observeToolProbe(probe, `CHAT_V2_TOOL_PROBE_RESULT=${'b'.repeat(64)}`), false);
  assert.equal(observeToolProbe(probe, `CHAT_V2_TOOL_PROBE_RESULT=${probe.expected.toUpperCase()}`), false);
  assert.equal(observeToolProbe(probe, `tool output CHAT_V2_TOOL_PROBE_RESULT=${probe.expected}`), true);
  assert.equal(toolProbeDiagnostic(probe), 'tool_signal=false;assistant_text=false;prefix=true;hex=true');

  cleanupToolProbe(probe);
  assert.equal(probe.secret, '');
  assert.equal(probe.command, '');
  assert.equal(probe.expected, '');
});

test('bridge verifies HMAC from a hidden tool-return wire and streams only the sanitized final answer', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-hmac-wire-fixture-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  await writeFile(fixture, `
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import { createInterface } from 'node:readline';
    const run = promisify(execFile);
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
      const { stdout } = await run('/bin/bash', ['-c', probe.command], {
        env: { ...process.env, PATH: '/definitely-not-a-real-path' },
      });
      console.log(JSON.stringify({
        type: 'stream_event',
        event: {
          message_type: 'tool_return_message',
          tool_name: 'Bash',
          content: probe.result_prefix + stdout.trim(),
        },
      }));
      const output = 'MODEL=openai/gpt-5.6 verified local tool operation completed';
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
  assert.ok(statuses.indexOf('tool.running:hmac_challenge_probe') >= 0);
  assert.ok(statuses.indexOf('tool.completed:hmac_challenge_probe') > statuses.indexOf('tool.running:hmac_challenge_probe'));
  assert.match(body, /verified local tool operation completed/);
  assert.doesNotMatch(body, /CHAT_V2_TOOL_PROBE_SECRET|CHAT_V2_TOOL_PROBE_RESULT=|[a-f0-9]{64}/i);
});

test('bridge fails closed with bounded diagnostics when no valid HMAC appears anywhere in the wire', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-hmac-wire-missing-'));
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
      if (JSON.parse(line).type !== 'user') continue;
      console.log(JSON.stringify({
        type: 'stream_event',
        event: { message_type: 'tool_return_message', tool_name: 'Bash', content: 'CHAT_V2_TOOL_PROBE_RESULT=' + '0'.repeat(64) },
      }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'claimed success' }));
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
  assert.match(body, /verified HMAC tool probe \(tool_signal=true;assistant_text=false;prefix=true;hex=true\)/);
  assert.doesNotMatch(body, /tool\.completed:hmac_challenge_probe/);
  assert.doesNotMatch(body, /CHAT_V2_TOOL_PROBE_RESULT=|[a-f0-9]{64}/i);
});
