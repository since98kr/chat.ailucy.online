import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerTemporaryRelayHostNormalization } from './copilot-relay-quick-tunnel.js';

const TEMPORARY_HOST = 'temporary-relay.trycloudflare.com';

async function appWith(enabled: boolean, temporaryHost = TEMPORARY_HOST) {
  const app = Fastify();
  registerTemporaryRelayHostNormalization(app, {
    enabled,
    canonicalHost: 'relay.ailucy.online',
    temporaryHost,
  });
  app.all('*', async (request) => ({ host: request.headers.host ?? null, url: request.url }));
  await app.ready();
  return app;
}

describe('temporary Copilot relay host normalization', () => {
  it('rewrites the exact configured Quick Tunnel MCP host', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/copilot-relay',
      headers: { host: TEMPORARY_HOST },
    });
    expect(response.json().host).toBe('relay.ailucy.online');
    await app.close();
  });

  it('rewrites broker paths including query strings for the exact configured host', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'GET',
      url: '/relay/copilot/outbox?limit=5',
      headers: { host: TEMPORARY_HOST },
    });
    expect(response.json().host).toBe('relay.ailucy.online');
    await app.close();
  });

  it('does not rewrite another trycloudflare hostname', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/copilot-relay',
      headers: { host: 'other-relay.trycloudflare.com' },
    });
    expect(response.json().host).toBe('other-relay.trycloudflare.com');
    await app.close();
  });

  it('does not rewrite non-relay routes even on the exact temporary host', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: TEMPORARY_HOST },
    });
    expect(response.json().host).toBe(TEMPORARY_HOST);
    await app.close();
  });

  it('is inert when the temporary fallback is disabled', async () => {
    const app = await appWith(false);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/copilot-relay',
      headers: { host: TEMPORARY_HOST },
    });
    expect(response.json().host).toBe(TEMPORARY_HOST);
    await app.close();
  });

  it('rejects an invalid configured temporary hostname', async () => {
    expect(() => registerTemporaryRelayHostNormalization(Fastify(), {
      enabled: true,
      temporaryHost: 'evil.example.com',
    })).toThrow(/INVALID_COPILOT_RELAY_QUICK_TUNNEL_HOST/);
  });
});
