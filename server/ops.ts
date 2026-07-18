import type { FastifyInstance } from 'fastify';
import { adapterHealth } from './adapters/index.js';
import { getBuildInfo } from './build-info.js';
import { securityConfigFromEnv } from './security.js';

export function registerOperationsRoutes(
  app: FastifyInstance,
  security = securityConfigFromEnv(),
) {
  app.get('/api/ops/status', async () => ({
    ok: true,
    build: getBuildInfo(),
    auth: {
      mode: security.authMode,
      allowedEmailCount: security.allowedEmails.size,
      allowedOriginCount: security.allowedOrigins.size,
    },
    adapters: await adapterHealth(),
    runtime: {
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
    },
    timestamp: new Date().toISOString(),
  }));
}
