import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTurnPrompt,
  createBridgeServer,
  extractRuntimeCapabilities,
  extractToolStatus,
  isAuthorized,
  loadConfig,
  validateRuntimeCapabilities,
} from './letta-cli-bridge.mjs';

const capabilities = {
  model: 'openai/gpt-5.6',
  tools: ['Read', 'Bash'],
  skillSources: ['bundled', 'global', 'agent', 'project'],
  slashCommands: ['/skills', '/github', '/model'],
  mcpServers: [{ name: 'filesystem', status: 'connected' }, { name: 'github', status: 'connected' }],
  mcpAdvertised: true,
  permissionMode: 'acceptEdits',
  memfsEnabled: true,
  sessionId: 'session-test',
};

function config(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    token: 'secret',
    agentId: 'agent-test',
    command: process.execPath,
    cwd: process.cwd(),
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
    requiredTools: ['Read'],
    requiredSkillSources: ['project'],
    requiredMcpServers: ['filesystem'],
    requiredSlashCommands: ['/skills'],
    spawnArgs: null,
    ...overrides,
  };
}

test('full bridge preserves CLI MemFS startup and requires complete capability by default', () => {
  const loaded = loadConfig({ LETTA_AGENT_ID: 'agent-test', LETTA_BRIDGE_TOKEN: 'secret' });
  assert.equal(loaded.memfsStartup, '');
  assert.deepEqual(loaded.extraArgs, []);
  assert.equal(loaded.requireModel, true);
  assert.equal(loaded.requireTools, true);
  assert.equal(loaded.requireSkillSources, true);
  assert.equal(loaded.requireMcpServers, true);
  assert.equal(loaded.requireSlashCommands, true);
  assert.equal(loaded.requireMemfs, true);
});

test('authorization uses an exact bearer token', () => {
  assert.equal(isAuthorized('Bearer abc', 'abc'), true);
  assert.equal(isAuthorized('Bearer abcd', 'abc'), false);
  assert.equal(isAuthorized(undefined, 'abc'), false);
});

test('official SystemInitMessage fields are normalized without arbitrary secret fields', () => {
  const parsed = extractRuntimeCapabilities({
    type: 'system',
    subtype: 'init',
    model: 'openai/gpt-5.6',
    tools: ['Read', 'Bash'],
    cwd: '/private/workspace',
    mcp_servers: [{ name: 'filesystem', status: 'connected', token: 'DO_NOT_COPY' }],
    permission_mode: 'acceptEdits',
    slash_commands: ['/skills', '/model'],
    memfs_enabled: true,
    skill_sources: ['bundled', 'global', 'agent', 'project'],
    session_id: 'session-test',
    access_token: 'DO_NOT_COPY',
  });
  assert.deepEqual(parsed, {
    model: 'openai/gpt-5.6',
    tools: ['Read', 'Bash'],
    skillSources: ['bundled', 'global', 'agent', 'project'],
    slashCommands: ['/skills', '/model'],
    mcpServers: [{ name: 'filesystem', status: 'connected' }],
    permissionMode: 'acceptEdits',
    memfsEnabled: true,
    sessionId: 'session-test',
  });
  assert.equal(parsed.mcpAdvertised, true);
  assert.doesNotMatch(JSON.stringify(parsed), /DO_NOT_COPY|private\/workspace/);
});

test('incomplete full-runtime capability fails closed', () => {
  assert.throws(() => validateRuntimeCapabilities(
    { model: null, tools: [], skillSources: [], slashCommands: [], mcpServers: [], memfsEnabled: false },
    config(),
  ), /did not advertise a model identity/);
  assert.throws(() => validateRuntimeCapabilities(
    { ...capabilities, tools: [] },
    config(),
  ), /did not advertise any tools/);
  assert.throws(() => validateRuntimeCapabilities(
    { ...capabilities, skillSources: [] },
    config(),
  ), /did not advertise any skill sources/);
  assert.throws(() => validateRuntimeCapabilities(
    { ...capabilities, mcpServers: [], mcpAdvertised: false },
    config(),
  ), /did not advertise MCP capability metadata/);
  assert.throws(() => validateRuntimeCapabilities(
    { ...capabilities, slashCommands: [] },
    config(),
  ), /did not advertise any slash commands/);
  assert.throws(() => validateRuntimeCapabilities(
    { ...capabilities, memfsEnabled: false },
    config(),
  ), /did not start with MemFS enabled/);
});

test('turn prompt identifies exact model, permissions, MemFS, tools, skill sources, commands, and MCP', () => {
  const prompt = buildTurnPrompt({ messages: [{ role: 'user', content: '네가 사용하는 모델과 기능이 뭐니?' }] }, false, capabilities);
  assert.match(prompt, /Runtime model: openai\/gpt-5\.6/);
  assert.match(prompt, /Permission mode: acceptEdits/);
  assert.match(prompt, /MemFS enabled: true/);
  assert.match(prompt, /CLI tools: Read, Bash/);
  assert.match(prompt, /Skill sources: bundled, global, agent, project/);
  assert.match(prompt, /Slash commands and skill invocations: \/skills, \/github, \/model/);
  assert.match(prompt, /MCP servers: filesystem\(connected\), github\(connected\)/);
  assert.match(prompt, /MCP metadata advertised by headless runtime: true/);
  assert.match(prompt, /answer with the exact Runtime model/);
});

test('official tool lifecycle is correlated and sanitized', () => {
  const names = new Map();
  assert.equal(extractToolStatus({
    type: 'message',
    message_type: 'tool_call_message',
    tool_call: { name: 'Read', tool_call_id: 'call-1', arguments: { path: '/private', token: 'SECRET' } },
  }, names), 'tool.running:Read');
  assert.equal(extractToolStatus({ type: 'tool_execution_started', tool_call_id: 'call-1' }, names), 'tool.running:Read');
  assert.equal(extractToolStatus({
    type: 'message',
    message_type: 'tool_return_message',
    tool_call_id: 'call-1',
    tool_return: 'PRIVATE_FILE',
  }, names), 'tool.completed:Read');
  assert.equal(extractToolStatus({ type: 'tool_execution_finished', tool_call_id: 'call-1', status: 'success' }, names), 'tool.completed:Read');
  assert.equal(extractToolStatus({ type: 'approval_requested', tool_call_id: 'call-2', tool_name: 'Bash' }, names), 'tool.approval_required:Bash');
});

test('bridge exposes exact runtime capability, streams safe tool progress, and reuses the CLI process', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-cli-bridge-test-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  const captured = join(fixtureDir, 'captured.txt');
  await writeFile(fixture, `
    import { appendFile } from 'node:fs/promises';
    import { createInterface } from 'node:readline';
    console.log(JSON.stringify({
      type: 'system', subtype: 'init', agent_id: 'agent-test', conversation_id: 'conversation-test', session_id: 'session-test',
      model: 'openai/gpt-5.6',
      tools: ['Read', 'Bash'],
      cwd: '/private/workspace',
      mcp_servers: [{ name: 'filesystem', status: 'connected' }, { name: 'github', status: 'connected' }],
      permission_mode: 'acceptEdits',
      slash_commands: ['/skills', '/github', '/model'],
      memfs_enabled: true,
      skill_sources: ['bundled', 'global', 'agent', 'project']
    }));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let turn = 0;
    for await (const line of lines) {
      const input = JSON.parse(line);
      if (input.type !== 'user') continue;
      turn += 1;
      await appendFile(${JSON.stringify(captured)}, input.message.content + '\\n---TURN---\\n');
      console.log(JSON.stringify({ type: 'message', message_type: 'tool_call_message', tool_call: {
        name: 'Read', tool_call_id: 'call-' + turn, arguments: { path: '/private', token: 'SECRET_ARGUMENT' }
      }}));
      console.log(JSON.stringify({ type: 'tool_execution_started', tool_call_id: 'call-' + turn }));
      console.log(JSON.stringify({ type: 'message', message_type: 'tool_return_message', tool_call_id: 'call-' + turn, tool_return: 'SECRET_RESULT' }));
      console.log(JSON.stringify({ type: 'tool_execution_finished', tool_call_id: 'call-' + turn, status: 'success' }));
      const output = 'MODEL=openai/gpt-5.6 TURN=' + turn;
      console.log(JSON.stringify({ type: 'stream_event', event: { message_type: 'assistant_message', content: [{ type: 'text', text: output }] } }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: output }));
    }
  `);

  const runtimeConfig = config({ cwd: fixtureDir, spawnArgs: [fixture] });
  const { server } = createBridgeServer(runtimeConfig);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const initialHealth = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(initialHealth.mode, 'full-cli-runtime');
  assert.equal(initialHealth.capabilities.initialized_sessions, 0);
  assert.equal((await fetch(`${base}/capabilities`)).status, 401);
  assert.equal((await fetch(`${base}/capabilities`, { headers: { Authorization: 'Bearer secret' } })).status, 503);

  const send = async (content, messageId) => {
    const response = await fetch(`${base}/v1/chat/stream`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conversation-1',
        agent_id: 'agent-test',
        messages: [{ role: 'user', content, message_id: messageId }],
      }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };

  const first = await send('모델과 기능을 확인하고 Read를 사용해.', 'm1');
  const firstItems = first.trim().split('\n').map(JSON.parse);
  assert.ok(firstItems.some((item) => item.status === 'runtime.model:openai/gpt-5.6'));
  assert.ok(firstItems.some((item) => item.status === 'runtime.permission:acceptEdits'));
  assert.ok(firstItems.some((item) => item.status === 'runtime.mcp_advertised:true'));
  assert.ok(firstItems.some((item) => item.status === 'runtime.capabilities:tools=2;skill_sources=4;mcp=2;commands=3;memfs=true'));
  assert.ok(firstItems.some((item) => item.status === 'tool.running:Read'));
  assert.ok(firstItems.some((item) => item.status === 'tool.completed:Read'));
  assert.ok(firstItems.some((item) => item.delta === 'MODEL=openai/gpt-5.6 TURN=1'));
  assert.doesNotMatch(first, /SECRET_ARGUMENT|SECRET_RESULT|\/private/);

  const advertised = await fetch(`${base}/capabilities`, { headers: { Authorization: 'Bearer secret' } }).then((response) => response.json());
  assert.equal(advertised.model, 'openai/gpt-5.6');
  assert.deepEqual(advertised.tools, ['Read', 'Bash']);
  assert.deepEqual(advertised.skill_sources, ['bundled', 'global', 'agent', 'project']);
  assert.deepEqual(advertised.slash_commands, ['/skills', '/github', '/model']);
  assert.deepEqual(advertised.mcp_servers, [{ name: 'filesystem', status: 'connected' }, { name: 'github', status: 'connected' }]);
  assert.equal(advertised.mcp_advertised, true);
  assert.equal(advertised.permission_mode, 'acceptEdits');
  assert.equal(advertised.memfs_enabled, true);
  assert.doesNotMatch(JSON.stringify(advertised), /session-test|private\/workspace|SECRET/);

  const second = await send('다시 확인해.', 'm2');
  assert.match(second, /TURN=2/);
  const promptLog = await readFile(captured, 'utf8');
  assert.match(promptLog, /Runtime model: openai\/gpt-5\.6/);
  assert.match(promptLog, /CLI tools: Read, Bash/);
  assert.match(promptLog, /Skill sources: bundled, global, agent, project/);
  assert.match(promptLog, /MCP servers: filesystem\(connected\), github\(connected\)/);
  assert.doesNotMatch(promptLog, /SECRET_ARGUMENT|SECRET_RESULT/);
});
