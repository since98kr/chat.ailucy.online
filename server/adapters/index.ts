import type { SystemId } from '../../shared/contracts.js';
import type { ChatBackendAdapter } from './types.js';
import { MockAdapter } from './mock.js';

const adapters: Record<SystemId, ChatBackendAdapter> = {
  letta: new MockAdapter('letta'),
  hermes: new MockAdapter('hermes'),
};

export function getAdapter(systemId: SystemId) {
  return adapters[systemId];
}

export async function adapterHealth() {
  const entries = await Promise.all(
    (Object.keys(adapters) as SystemId[]).map(async (systemId) => [systemId, await adapters[systemId].health()] as const),
  );
  return Object.fromEntries(entries) as Record<SystemId, { ok: boolean; detail: string }>;
}
