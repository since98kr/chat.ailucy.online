import { buildApp } from './index.js';
import { ChatDatabase } from './database.js';
import { registerCopilotRelayMcp } from './copilot-relay-mcp.js';
import { createOperationalRelayOidcVerifier } from './copilot-relay-oidc.js';
import { registerTemporaryRelayHostNormalization } from './copilot-relay-quick-tunnel.js';
import { registerOperationsRoutes } from './ops.js';
import { registerRuntimeSecurity } from './security.js';
import { registerProductionWeb } from './web.js';

async function start() {
  const app = buildApp();
  const security = registerRuntimeSecurity(app);
  registerTemporaryRelayHostNormalization(app);
  const relayDb = new ChatDatabase();
  registerCopilotRelayMcp(app, relayDb, { oidcVerifier: createOperationalRelayOidcVerifier() });
  app.addHook('onClose', async () => relayDb.close());
  registerOperationsRoutes(app, security);
  registerProductionWeb(app);

  const port = Number(process.env.CHAT_API_PORT ?? 4174);
  await app.listen({ host: '0.0.0.0', port });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
