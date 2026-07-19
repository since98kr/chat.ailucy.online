import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from './bootstrap-cloudflare-staging-access.mjs';

function reply(response, result, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ success: status >= 200 && status < 300, result, errors: [] }));
}

async function startMockCloudflare() {
  const data = {
    application: null,
    policies: [],
    token: null,
    tokenCreates: 0,
    tokenRotations: 0,
  };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-api-token');
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await new Promise((resolve) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null));
    });
    const prefix = '/client/v4/accounts/account-1';

    if (request.method === 'GET' && url.pathname === `${prefix}/access/organizations`) {
      reply(response, { auth_domain: 'tei-team.cloudflareaccess.com' });
      return;
    }
    if (request.method === 'GET' && url.pathname === `${prefix}/access/apps`) {
      reply(response, data.application ? [data.application] : []);
      return;
    }
    if (request.method === 'POST' && url.pathname === `${prefix}/access/apps`) {
      assert.deepEqual(body, {
        name: 'Chat V2 isolated staging',
        domain: 'chat-staging.ailucy.online',
        type: 'self_hosted',
        session_duration: '24h',
        app_launcher_visible: false,
      });
      data.application = { id: 'app-1', aud: 'aud-1', domain: body.domain, type: body.type };
      reply(response, data.application);
      return;
    }
    if (request.method === 'GET' && url.pathname === `${prefix}/access/apps/app-1/policies`) {
      reply(response, data.policies);
      return;
    }
    if (request.method === 'POST' && url.pathname === `${prefix}/access/apps/app-1/policies`) {
      const policy = { ...body, id: `policy-${data.policies.length + 1}` };
      data.policies.push(policy);
      reply(response, policy);
      return;
    }
    if (request.method === 'PUT' && url.pathname.startsWith(`${prefix}/access/apps/app-1/policies/`)) {
      const id = url.pathname.split('/').at(-1);
      const index = data.policies.findIndex((policy) => policy.id === id);
      assert.notEqual(index, -1);
      data.policies[index] = { ...body, id };
      reply(response, data.policies[index]);
      return;
    }
    if (request.method === 'GET' && url.pathname === `${prefix}/access/service_tokens`) {
      reply(response, data.token ? [{ id: data.token.id, client_id: data.token.client_id, name: data.token.name }] : []);
      return;
    }
    if (request.method === 'POST' && url.pathname === `${prefix}/access/service_tokens`) {
      data.tokenCreates += 1;
      data.token = {
        id: 'token-1',
        client_id: 'client-1.access',
        client_secret: 'secret-1',
        name: body.name,
      };
      reply(response, data.token);
      return;
    }
    if (request.method === 'POST' && url.pathname === `${prefix}/access/service_tokens/token-1/rotate`) {
      data.tokenRotations += 1;
      data.token = { ...data.token, client_secret: `secret-${data.tokenRotations + 1}` };
      reply(response, data.token);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: false, errors: [{ message: `${request.method} ${url.pathname} not mocked` }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    data,
    apiRoot: `http://127.0.0.1:${address.port}/client/v4`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const originalEnv = { ...process.env };

test('creates and then idempotently reuses the Access app, policies, and persisted service token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-v2-cloudflare-bootstrap-'));
  const statePath = join(directory, 'secrets', 'cloudflare-access-staging.json');
  const mock = await startMockCloudflare();
  try {
    process.env.CLOUDFLARE_API_ROOT = mock.apiRoot;
    process.env.CLOUDFLARE_API_TOKEN = 'test-api-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-1';
    process.env.CHAT_PUBLIC_ORIGIN = 'https://chat-staging.ailucy.online';
    process.env.CHAT_ALLOWED_EMAILS = 'Tei@Example.com,tei@example.com';
    process.env.CHAT_CLOUDFLARE_ACCESS_STATE_FILE = statePath;

    const first = await main();
    assert.equal(first.clientSecret, 'secret-1');
    assert.equal(first.issuer, 'https://tei-team.cloudflareaccess.com');
    assert.equal(first.audience, 'aud-1');
    assert.equal(mock.data.tokenCreates, 1);
    assert.equal(mock.data.tokenRotations, 0);
    assert.deepEqual(mock.data.policies.map((policy) => policy.decision).sort(), ['allow', 'non_identity']);
    assert.deepEqual(mock.data.policies.find((policy) => policy.decision === 'allow').include, [
      { email: { email: 'tei@example.com' } },
    ]);

    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(stored.clientSecret, 'secret-1');
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);

    const second = await main();
    assert.equal(second.clientSecret, 'secret-1');
    assert.equal(mock.data.tokenCreates, 1);
    assert.equal(mock.data.tokenRotations, 0);
    assert.equal(mock.data.policies.length, 2);
  } finally {
    process.env = { ...originalEnv };
    await mock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses to enable Access without preserving at least one human administrator', async () => {
  process.env = { ...originalEnv };
  process.env.CLOUDFLARE_API_TOKEN = 'test-api-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account-1';
  process.env.CHAT_ALLOWED_EMAILS = '';
  await assert.rejects(main(), /at least one human administrator/);
  process.env = { ...originalEnv };
});
