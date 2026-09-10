import type { SystemId } from '../shared/contracts';

export const LEGACY_LETTA_LUCY_ID = '[Letta] Lucy';
export const OPENCLAW_LUCY_ID = '[OpenClaw] Lucy';
export const CHATGPT_LUCY_ID = '[ChatGPT] Lucy';

/**
 * `letta` remains a legacy persistence/transport key while the existing
 * OpenClaw-backed conversations are migrated. It is never the user-facing
 * personal Lucy product identity.
 */
export function displaySystemName(systemId: SystemId) {
  if (systemId === 'letta') return 'OpenClaw';
  if (systemId === 'hermes') return 'Hermes';
  return 'Claude';
}

export function displayAgentId(agentId: string) {
  return agentId === LEGACY_LETTA_LUCY_ID ? OPENCLAW_LUCY_ID : agentId;
}

export function isOpenClawLucy(agentId: string) {
  return agentId === LEGACY_LETTA_LUCY_ID || agentId === OPENCLAW_LUCY_ID;
}
