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
} from './letta-full-bridge.mjs';

const capabilities = {
  model: 'openai/gpt-5.6',
  tools: ['read_file', 'shell'],
  skills: ['github', 'pdf'],
  mcpServers: ['filesystem', 'github'],
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
    requiredTools: ['read_file'],
    requiredSkills: ['github'],
    requiredMcpServers: ['filesystem'],
    spawnArgs: null,
    ...overrides,
  };
}

test('full bridge defaults to the CLI startup behavior instead of forcing MemFS skip', () => {
  const loaded = loadConfig({ LETTA_AGENT_ID: 'agent-test', LETTA_BRIDGE_TOKEN: 'secret' });
  assert.equal(loaded.memfsStartup, '');
  assert.deepEqual(loaded.extraArgs, []);
  assert.equal(loaded.requireModel, true);
});

test('authorization uses an exact bearer token', () => {
  assert.equal(isAuthorized('Bearer abc', 'abc'), true);
  assert.equal(isAuthorized('Bearer abcd', 'abc'), false);
  assert.equal(isAuthorized(undefined, 'abc'), false);
});

test('runtime init is normalized without retaining secret-like arbitrary fields', () => {
  const parsed = extractRuntimeCapabilities({
    type: 'system',
    subtype: 'init',
    model_id: 'openai/gpt-5.6',
    tools: [{ name: 'read_file', api_key: 'DO_NOT_COPY' }, { name: 'shell' }],
    skills: [{ name: 'github' }],
    mcp_servers: [{ name: 'filesystem', token: 'DO_NOT_COPY' }],
    session_id: 'session-test',
    access_token: 'DO_NOT_COPY',
  });
  assert.deepEqual(parsed, {
    model: 'openai/gpt-5.6',
    tools: ['read_file', 'shell'],
    skills: ['github'],
    mcpServers: ['filesystem'],
    sessionId: 'session-test',
  });
  assert.doesNotMatch(JSON.stringify(parsed), /DO_NOT_COPY/);
});

test('required full-runtime capabilities fail closed', () => {
  assert.throws(() => validateRuntimeCapabilities(
    { model: null, tools: [], skills: [], mcpServers: [] },
    config(),
  ), /did not advertise a model identity/);
  assert.throws(() => validateRuntimeCapabilities(
    { model: 'model', tools: [], skills: ['github'], mcpServers: ['filesystem'] },
    config(),
  ), /missing required tool: read_file/);
});

test('turn prompt identifies the exact CLI runtime model and capabilities', () => {
  const prompt = buildTurnPrompt({ messages: [{ role: 'user', content: '네가 사용하는 모델이 뭐니?' }] }, false, capabilities);
  assert.match(prompt, /Runtime model: openai\/gpt-5\.6/);
  assert.match(prompt, /CLI tools: read_file, shell/);
  assert.match(prompt, /Skills: github, pdf/);
  assert.match(prompt, /MCP servers: filesystem, github/);
  assert.match(prompt, /answer with the exact Runtime model/);
});

test('tool status is sanitized and never includes arguments or results', () => {
  assert.equal(extractToolStatus({
    type: 'stream_event',
    event: { message_type: 'tool_call_message', tool_name: 'read_file', arguments: { token: 'SECRET' } },
  }), 'tool.running:read_file');
  assert.equal(extractToolStatus({
    type: 'stream_event',
    event: { message_type: 'tool_return_message', tool_name: 'read_file', tool_return: 'PRIVATE_FILE' },
  }), 'tool.completed:read_file');
});

test('bridge exposes runtime identity, streams sanitized tool progress, and reuses the CLI process', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-full-bridge-test-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  const captured = join(fixtureDir, 'captured.txt');
  await writeFile(fixture, `
    import { appendFile } from 'node:fs/promises';
    import { createInterface } from 'node:readline';
    console.log(JSON.stringify({
      type: 'system', subtype: 'init', agent_id: 'agent-test', session_id: 'session-test',
      model_id: 'openai/gpt-5.6',
      tools: [{ name: 'read_file' }, { name: 'shell' }],
      skills: [{ name: 'github' }, { name: 'pdf' }],
      mcp_servers: [{ name: 'filesystem' }, { name: 'github' }]
    }));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let turn = 0;
    for await (const line of lines) {
      const input = JSON.parse(line);
      if (input.type !== 'user') continue;
      turn += 1;
      await appendFile(${JSON.stringify(captured)}, input.message.content + '\\n---TURN---\\n');
      console.log(JSON.stringify({ type: 'stream_event', event: {
        message_type: 'tool_call_message', tool_name: 'read_file', arguments: { path: '/private', token: 'SECRET_ARGUMENT' }
      }}));
      console.log(JSON.stringify({ type: 'stream_event', event: {
        message_type: 'tool_return_message', tool_name: 'read_file', tool_return: 'SECRET_RESULT'
      }}));
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

  const unauthorizedCapabilities = await fetch(`${base}/capabilities`);
  assert.equal(unauthorizedCapabilities.status, 401);

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

  const first = await send('모델과 도구를 확인해.', 'm1');
  const firstItems = first.trim().split('\n').map(JSON.parse);
  assert.ok(firstItems.some((item) => item.status === 'runtime.model:openai/gpt-5.6'));
  assert.ok(firstItems.some((item) => item.status === 'runtime.capabilities:tools=2;skills=2;mcp=2'));
  assert.ok(firstItems.some((item) => item.status === 'tool.running:read_file'));
  assert.ok(firstItems.some((item) => item.status === 'tool.completed:read_file'));
  assert.ok(firstItems.some((item) => item.delta === 'MODEL=openai/gpt-5.6 TURN=1'));
  assert.doesNotMatch(first, /SECRET_ARGUMENT|SECRET_RESULT|\/private/);

  const advertised = await fetch(`${base}/capabilities`, { headers: { Authorization: 'Bearer secret' } }).then((response) => response.json());
  assert.equal(advertised.model, 'openai/gpt-5.6');
  assert.deepEqual(advertised.tools, ['read_file', 'shell']);
  assert.deepEqual(advertised.skills, ['github', 'pdf']);
  assert.deepEqual(advertised.mcp_servers, ['filesystem', 'github']);

  const second = await send('다시 확인해.', 'm2');
  assert.match(second, /TURN=2/);
  const promptLog = await readFile(captured, 'utf8');
  assert.match(promptLog, /Runtime model: openai\/gpt-5\.6/);
  assert.match(promptLog, /CLI tools: read_file, shell/);
  assert.match(promptLog, /MCP servers: filesystem, github/);
  assert.doesNotMatch(promptLog, /SECRET_ARGUMENT|SECRET_RESULT/);
});
