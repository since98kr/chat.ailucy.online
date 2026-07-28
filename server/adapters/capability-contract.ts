import type { AgentRecord, ConversationParticipantRecord, SystemId } from '../../shared/contracts.js';
import type { AdapterRequest } from './types.js';

const MAX_IDENTITY_LENGTH = 256;
const MAX_CAPABILITY_LENGTH = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

type ApprovedAgent = {
  agentId: string;
  capabilities: string[];
  isLead: boolean;
};

export type ApprovedAdapterCapabilities = {
  selectedAgent: { agentId: string; capabilities: string[] };
  approvedSubagents: Array<{ agentId: string; capabilities: string[] }>;
};

export type SanitizedRuntimeIdentity = {
  provider: string;
  model: string;
  selectedAgentId: string;
};

function printableIdentifier(value: string, label: string, maxLength = MAX_IDENTITY_LENGTH) {
  const sanitized = value.replace(CONTROL_CHARACTERS, '').trim();
  if (!sanitized || sanitized.length > maxLength) {
    throw new Error(`${label} must be a non-empty printable identifier no longer than ${maxLength} characters`);
  }
  return sanitized;
}

function sanitizedCapabilities(capabilities: string[]) {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== 'string') continue;
    const sanitized = capability.replace(CONTROL_CHARACTERS, '').trim();
    if (sanitized && sanitized.length <= MAX_CAPABILITY_LENGTH) seen.add(sanitized);
  }
  return [...seen].sort();
}

function approvedParticipant(participant: ConversationParticipantRecord, systemId: SystemId): ApprovedAgent | null {
  if (participant.agentId !== participant.agent.id
    || participant.agent.systemId !== systemId
    || !participant.agent.enabled
    || participant.state === 'offline'
    || participant.state === 'blocked') return null;
  return {
    agentId: printableIdentifier(participant.agentId, 'participant agent id'),
    capabilities: sanitizedCapabilities(participant.agent.capabilities),
    isLead: participant.role === 'lead' || participant.agent.isLead,
  };
}

function approvedFederatedAgent(agent: AgentRecord, systemId: SystemId): ApprovedAgent | null {
  if (agent.systemId !== systemId || !agent.enabled) return null;
  return {
    agentId: printableIdentifier(agent.id, 'federated agent id'),
    capabilities: sanitizedCapabilities(agent.capabilities),
    isLead: agent.isLead,
  };
}

function approvedAgents(request: AdapterRequest, systemId: SystemId) {
  const agents = new Map<string, ApprovedAgent>();
  for (const participant of request.participants) {
    const approved = approvedParticipant(participant, systemId);
    if (approved) agents.set(approved.agentId, approved);
  }
  for (const agent of request.federatedAgents ?? []) {
    const approved = approvedFederatedAgent(agent, systemId);
    if (approved && !agents.has(approved.agentId)) agents.set(approved.agentId, approved);
  }
  return agents;
}

/**
 * Builds the capability handshake from agents already authorized by Chat V2.
 * It deliberately never trusts backend-discovered agents or capabilities.
 */
export function approvedAdapterCapabilities(request: AdapterRequest, systemId: SystemId): ApprovedAdapterCapabilities {
  const selectedAgentId = printableIdentifier(request.selectedAgentId ?? request.targetAgentId, 'selected agent id');
  const agents = approvedAgents(request, systemId);
  const selectedAgent = agents.get(selectedAgentId);
  if (!selectedAgent) throw new Error(`Selected agent is not authorized for this execution: ${selectedAgentId}`);

  return {
    selectedAgent: { agentId: selectedAgent.agentId, capabilities: selectedAgent.capabilities },
    // Only a selected lead can discover its collaborators. A subagent must not
    // learn sibling identities/capabilities merely by being invoked in a team.
    approvedSubagents: request.routingMode === 'team' && selectedAgent.isLead
      ? [...agents.values()]
        .filter((agent) => agent.agentId !== selectedAgent.agentId)
        .map((agent) => ({ agentId: agent.agentId, capabilities: agent.capabilities }))
      : [],
  };
}

export function authorizeSelectedAgentExecution(
  selectedAgentId: string,
  targetAgentId: string,
  configuredRuntimeTarget?: string,
) {
  const selected = printableIdentifier(selectedAgentId, 'selected agent id');
  const target = printableIdentifier(targetAgentId, 'target agent id');
  const configuredTarget = configuredRuntimeTarget
    ? printableIdentifier(configuredRuntimeTarget, 'configured runtime target')
    : undefined;
  if (target !== selected && target !== configuredTarget) {
    throw new Error(`Target agent does not match selected agent authorization: ${target}`);
  }
  return target;
}

export function sanitizeRuntimeIdentity(identity: SanitizedRuntimeIdentity): SanitizedRuntimeIdentity {
  return {
    provider: printableIdentifier(identity.provider, 'provider'),
    model: printableIdentifier(identity.model, 'model'),
    selectedAgentId: printableIdentifier(identity.selectedAgentId, 'selected agent id'),
  };
}
