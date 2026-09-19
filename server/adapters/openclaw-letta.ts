// Migration-era import compatibility only.
//
// Letta is retired as a current Chat system identity. New runtime code must
// import from `./openclaw.js`; these aliases exist solely so older internal
// imports/tests can move without reintroducing a live `letta` adapter key.
export {
  OpenClawAdapter as OpenClawLettaAdapter,
  openClawConfigFromEnv as openClawLettaConfigFromEnv,
} from './openclaw.js';
export type { OpenClawConfig as OpenClawLettaConfig } from './openclaw.js';
