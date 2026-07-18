import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTurnPrompt,
  createBridgeServer,
  extractAssistantDelta,
  isAuthorized,
} from './letta-bridge.mjs';

test('authorization uses an exact bearer token', () => {
  assert.equal(isAuthorized('Bearer abc', 'abc'), true);
  assert.equal(isAuthorized('Bearer abcd', 'abc'), false);
  assert.equal(isAuthorized(undefined, 'abc'), false);
});

test('recovery prompt separates prior transcript from current message', () => {
  const prompt = buildTurnPrompt({ messages: [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'new' },
  ] }, true);
  assert.match(prompt, /<TRANSCRIPT>/);
  assert.match(prompt, /\[ASSISTANT\]\nreply/);
  assert.match(prompt, /CURRENT USER MESSAGE:\n\nnew/);
});

test('assistant deltas are extracted from Letta stream events', () => {
  assert.equal(extractAssistantDelta({
    type: 'stream_event',
    event: { message_type: 'assistant_message', content: [{ type: 'text', text: 'OK' }] },
  }), 'OK');
});

test('bridge streams replies and reuses the conversation process', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'letta-bridge-test-'));
  const fixture = join(fixtureDir, 'fixture.mjs');
  await writeFile(fixture, `
    import { createInterface } from 'node:readline';
    console.log(JSON.stringify({ type: 'system', subtype: 'init', agent_id: 'agent-test', session_id: 'agent-test' }));
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let turn = 0;
    for await (const line of lines) {
      const input = JSON.parse(line);
      if (input.type !== 'user') continue;
      turn += 1;
      const output = (turn === 1 ? 'ONE:' : 'TWO:') + input.message.content;
      const midpoint = Math.ceil(output.length / 2);
      for (const part of [output.slice(0, midpoint), output.slice(midpoint)]) {
        console.log(JSON.stringify({ type: 'stream_event', event: { message_type: 'assistant_message', content: [{ type: 'text', text: part }] } }));
      }
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: output }));
    }
  `);

  const config = {
    host: '127.0.0.1',
    port: 0,
    token: 'secret',
    agentId: 'agent-test',
    command: process.execPath,
    cwd: fixtureDir,
    backend: 'local',
    maxSessions: 2,
    idleMs: 60_000,
    requestTimeoutMs: 5_000,
    maxBodyBytes: 100_000,
    spawnArgs: [fixture],
  };
  const { server } = createBridgeServer(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const unauthorized = await fetch(`${base}/v1/chat/stream`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const send = async (content, messageId, history = []) => {
    const response = await fetch(`${base}/v1/chat/stream`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conversation-1',
        agent_id: 'agent-test',
        messages: [...history, { role: 'user', content, message_id: messageId }],
      }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const decode = (body) => body.trim().split('\n').map(JSON.parse).map((item) => item.delta || '').join('');

  assert.equal(decode(await send('hello', 'm1')), 'ONE:hello');
  assert.equal(decode(await send('again', 'm2', [
    { role: 'user', content: 'hello', message_id: 'm1' },
    { role: 'assistant', content: 'prior', message_id: 'a1' },
  ])), 'TWO:again');
  assert.equal(decode(await send('again', 'm2')), 'TWO:again');
});
