import { buildApp } from './index.js';
import { registerRuntimeSecurity } from './security.js';
import { registerProductionWeb } from './web.js';

async function start() {
  const app = buildApp();
  registerRuntimeSecurity(app);
  registerProductionWeb(app);

  const port = Number(process.env.CHAT_API_PORT ?? 4174);
  await app.listen({ host: '0.0.0.0', port });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
