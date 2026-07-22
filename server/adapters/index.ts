import type { AdapterHealthRecord, SystemId } from '../../shared/contracts.js';
import type { AdapterRequest, ChatBackendAdapter } from './types.js';
import { wrapArtifactEnvelopeFallback } from './artifact-envelope.js';
import { MockAdapter } from './mock.js';
import { HttpAgentAdapter, httpAdapterConfig } from './http.js';
import { augmentNativeArtifactContext } from './native-artifacts.js';

export function resolveNativeTargetAgentId(
  requestedAgentId: string,
  conversationAgentId: string,
  configuredAgentId?: string,
  modelMap?: Record<string, string>,
) {
  const requested = requestedAgentId || conversationAgentId;
  return modelMap?.[requested]
    ?? (configuredAgentId && requested === conversationAgentId ? configuredAgentId : requested);
}

function enabled(value: string | undefined) {
  return (value ?? '').trim().toLowerCase() === 'true';
}

function wrapNativeAgentMapping(
  adapter: ChatBackendAdapter,
  configuredAgentId?: string,
  modelMap?: Record<string, string>,
): ChatBackendAdapter {
  return {
    systemId: adapter.systemId,
    health: () => adapter.health(),
    async *streamReply(request: AdapterRequest) {
      const targetAgentId = resolveNativeTargetAgentId(
        request.targetAgentId,
        request.conversation.agentId,
        configuredAgentId,
        modelMap,
      );
      const mapped = targetAgentId === request.targetAgentId ? request : { ...request, targetAgentId };
      const withArtifacts = await augmentNativeArtifactContext(adapter.systemId, mapped);
      yield* adapter.streamReply(withArtifacts);
    },
  };
}

function createAdapter(systemId: SystemId): ChatBackendAdapter {
  const config = httpAdapterConfig(systemId);
  if (!config) return new MockAdapter(systemId);
  const httpAdapter = new HttpAgentAdapter(systemId, config);
  const adapter = config.protocol === 'native'
    ? wrapNativeAgentMapping(httpAdapter, config.agentId, config.modelMap)
    : httpAdapter;
  return systemId === 'hermes'
    && config.protocol === 'openai'
    && enabled(process.env.HERMES_ARTIFACT_ENVELOPE_ENABLED)
    ? wrapArtifactEnvelopeFallback(adapter)
    : adapter;
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
