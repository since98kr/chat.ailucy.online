import type { FastifyInstance, FastifyRequest } from 'fastify';

const CANONICAL_RELAY_HOST = 'relay.ailucy.online';
const MCP_PATH = '/mcp/copilot-relay';
const BROKER_PREFIX = '/relay/copilot/';
const QUICK_HOST_RE = /^[a-z0-9-]+\.trycloudflare\.com$/i;

function pathOnly(request: FastifyRequest) {
  return request.url.split('?', 1)[0] ?? request.url;
}

function isRelayPath(request: FastifyRequest) {
  const path = pathOnly(request);
  return path === MCP_PATH || path.startsWith(BROKER_PREFIX);
}

function requestHostname(request: FastifyRequest) {
  return (request.headers.host ?? '').split(':')[0].trim().toLowerCase();
}

function normalizeConfiguredQuickHost(value: string | undefined) {
  const host = (value ?? '').trim().toLowerCase();
  if (!host) return '';
  if (!QUICK_HOST_RE.test(host)) throw new Error('INVALID_COPILOT_RELAY_QUICK_TUNNEL_HOST');
  return host;
}

export function shouldNormalizeTemporaryRelayHost(
  request: FastifyRequest,
  options: { enabled?: boolean; temporaryHost?: string } = {},
) {
  const enabled = options.enabled ?? process.env.COPILOT_RELAY_QUICK_TUNNEL_ENABLED === 'true';
  if (!enabled || !isRelayPath(request)) return false;
  const temporaryHost = normalizeConfiguredQuickHost(
    options.temporaryHost ?? process.env.COPILOT_RELAY_QUICK_TUNNEL_HOST,
  );
  return Boolean(temporaryHost) && requestHostname(request) === temporaryHost;
}

export function registerTemporaryRelayHostNormalization(
  app: FastifyInstance,
  options: { enabled?: boolean; canonicalHost?: string; temporaryHost?: string } = {},
) {
  const enabled = options.enabled ?? process.env.COPILOT_RELAY_QUICK_TUNNEL_ENABLED === 'true';
  const canonicalHost = options.canonicalHost ?? CANONICAL_RELAY_HOST;
  const temporaryHost = normalizeConfiguredQuickHost(
    options.temporaryHost ?? process.env.COPILOT_RELAY_QUICK_TUNNEL_HOST,
  );
  if (!enabled || !temporaryHost) return;

  app.addHook('onRequest', async (request) => {
    if (!shouldNormalizeTemporaryRelayHost(request, { enabled: true, temporaryHost })) return;
    request.headers.host = canonicalHost;
  });
}
