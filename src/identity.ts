import type { SystemId } from '../shared/contracts';

export const LEGACY_LETTA_LUCY_ID = '[Letta] Lucy';
export const OPENCLAW_LUCY_ID = '[OpenClaw] Lucy';
export const CHATGPT_LUCY_ID = '[ChatGPT] Lucy';

export function displaySystemName(systemId: SystemId) {
  switch (systemId) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes': return 'Hermes';
    case 'claude': return 'Claude';
    case 'b200': return 'B200';
  }
}

/** Legacy agent ids may still arrive from migrated historical messages. */
export function displayAgentId(agentId: string) {
  return agentId === LEGACY_LETTA_LUCY_ID ? OPENCLAW_LUCY_ID : agentId;
}

export function isOpenClawLucy(agentId: string) {
  return agentId === LEGACY_LETTA_LUCY_ID || agentId === OPENCLAW_LUCY_ID;
}
