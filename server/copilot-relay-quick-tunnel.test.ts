import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerTemporaryRelayHostNormalization } from './copilot-relay-quick-tunnel.js';

async function appWith(enabled: boolean) {
  const app = Fastify();
  registerTemporaryRelayHostNormalization(app, { enabled, canonicalHost: 'relay.ailucy.online' });
  app.all('*', async (request) => ({ host: request.headers.host ?? null, url: request.url }));
  await app.ready();
  return app;
}

describe('temporary Copilot relay host normalization', () => {
  it('rewrites Cloudflare MCP requests only when explicitly enabled', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/copilot-relay',
      headers: { host: 'temporary.trycloudflare.com', 'cf-ray': 'abc123-ICN' },
    });
    expect(response.json().host).toBe('relay.ailucy.online');
    await app.close();
  });

  it('rewrites Cloudflare broker paths including query strings', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'GET',
      url: '/relay/copilot/outbox?limit=5',
      headers: { host: 'temporary.trycloudflare.com', 'cf-ray': 'abc123-ICN' },
    });
    expect(response.json().host).toBe('relay.ailucy.online');
    await app.close();
  });

  it('does not rewrite requests without Cloudflare edge evidence', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/copilot-relay',
      headers: { host: 'temporary.trycloudflare.com' },
    });
    expect(response.json().host).toBe('temporary.trycloudflare.com');
    await app.close();
  });

  it('does not rewrite non-relay routes', async () => {
    const app = await appWith(true);
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'temporary.trycloudflare.com', 'cf-ray': 'abc123-ICN' },
    });
    expect(response.json().host).toBe('temporary.trycloudflare.com');
    await app.close();
  });

  it('is inert when the temporary fallback is disabled', async () => {
    const app = await appWith(false);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/copilot-relay',
      headers: { host: 'temporary.trycloudflare.com', 'cf-ray': 'abc123-ICN' },
    });
    expect(response.json().host).toBe('temporary.trycloudflare.com');
    await app.close();
  });
});
