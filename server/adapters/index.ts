import type { AdapterHealthRecord, SystemId } from '../../shared/contracts.js';
import type { ChatBackendAdapter } from './types.js';
import { MockAdapter } from './mock.js';
import { HttpAgentAdapter, httpAdapterConfig } from './http.js';

function createAdapter(systemId: SystemId): ChatBackendAdapter {
  const config = httpAdapterConfig(systemId);
  return config ? new HttpAgentAdapter(systemId, config) : new MockAdapter(systemId);
}

const adapters: Record<SystemId, ChatBackendAdapter> = {
  letta: createAdapter('letta'),
  hermes: createAdapter('hermes'),
};

export function getAdapter(systemId: SystemId) {
  return adapters[systemId];
}

export async function adapterHealth() {
  const entries = await Promise.all(
    (Object.keys(adapters) as SystemId[]).map(async (systemId) => [systemId, await adapters[systemId].health()] as const),
  );
  return Object.fromEntries(entries) as Record<SystemId, AdapterHealthRecord>;
}
