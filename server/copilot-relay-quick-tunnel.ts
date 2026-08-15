import type { FastifyInstance, FastifyRequest } from 'fastify';

const CANONICAL_RELAY_HOST = 'relay.ailucy.online';
const MCP_PATH = '/mcp/copilot-relay';
const BROKER_PREFIX = '/relay/copilot/';

function pathOnly(request: FastifyRequest) {
  return request.url.split('?', 1)[0] ?? request.url;
}

function isRelayPath(request: FastifyRequest) {
  const path = pathOnly(request);
  return path === MCP_PATH || path.startsWith(BROKER_PREFIX);
}

function hasCloudflareEdgeProof(request: FastifyRequest) {
  const cfRay = request.headers['cf-ray'];
  return typeof cfRay === 'string' ? cfRay.trim().length > 0 : Array.isArray(cfRay) && cfRay.length > 0;
}

export function shouldNormalizeTemporaryRelayHost(
  request: FastifyRequest,
  enabled = process.env.COPILOT_RELAY_QUICK_TUNNEL_ENABLED === 'true',
) {
  return enabled && isRelayPath(request) && hasCloudflareEdgeProof(request);
}

export function registerTemporaryRelayHostNormalization(
  app: FastifyInstance,
  options: { enabled?: boolean; canonicalHost?: string } = {},
) {
  const enabled = options.enabled ?? process.env.COPILOT_RELAY_QUICK_TUNNEL_ENABLED === 'true';
  const canonicalHost = options.canonicalHost ?? CANONICAL_RELAY_HOST;
  if (!enabled) return;

  app.addHook('onRequest', async (request) => {
    if (!shouldNormalizeTemporaryRelayHost(request, true)) return;
    request.headers.host = canonicalHost;
  });
}
