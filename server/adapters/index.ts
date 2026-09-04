import type { AdapterHealthRecord, SystemId } from '../../shared/contracts.js';
import type { AdapterRequest, ChatBackendAdapter } from './types.js';
import { wrapArtifactEnvelopeFallback } from './artifact-envelope.js';
import { MockAdapter, UnavailableAdapter } from './mock.js';
import { HttpAgentAdapter, httpAdapterConfig } from './http.js';
import { OpenClawLettaAdapter, openClawLettaConfigFromEnv } from './openclaw-letta.js';
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

export function resolveNativeExecution(
  requestedAgentId: string,
  selectedAgentId: string,
  conversationAgentId: string,
  configuredAgentId?: string,
  modelMap?: Record<string, string>,
) {
  const targetAgentId = resolveNativeTargetAgentId(
    requestedAgentId,
    conversationAgentId,
    configuredAgentId,
    modelMap,
  );

  // A configured native backend target is authorized only for the selected
  // conversation lead that the wrapper itself mapped. Explicit team targets
  // continue to require their own model-map entry and arbitrary runtime IDs
  // never become authorized merely because they were requested.
  const authorizationModelMap = configuredAgentId
    && requestedAgentId === conversationAgentId
    && targetAgentId === configuredAgentId
    ? { ...modelMap, [selectedAgentId || requestedAgentId]: configuredAgentId }
    : modelMap;

  return { targetAgentId, authorizationModelMap };
}

function enabled(value: string | undefined) {
  return (value ?? '').trim().toLowerCase() === 'true';
}

function protocol(value: string | undefined) {
  return (value ?? '').trim().toLowerCase();
}

export function mockAdaptersAllowed(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV === 'test' || enabled(env.CHAT_ALLOW_MOCK_ADAPTERS);
}

function wrapNativeAgentMapping(
  adapter: HttpAgentAdapter,
  configuredAgentId?: string,
  modelMap?: Record<string, string>,
): ChatBackendAdapter {
  return {
    systemId: adapter.systemId,
    health: () => adapter.health(),
    async *streamReply(request: AdapterRequest) {
      const selectedAgentId = request.selectedAgentId ?? request.targetAgentId;
      const execution = resolveNativeExecution(
        request.targetAgentId,
        selectedAgentId,
        request.conversation.agentId,
        configuredAgentId,
        modelMap,
      );
      const mapped = execution.targetAgentId === request.targetAgentId
        ? request
        : { ...request, selectedAgentId, targetAgentId: execution.targetAgentId };
      const withArtifacts = await augmentNativeArtifactContext(adapter.systemId, mapped);
      const executionAdapter = execution.authorizationModelMap === modelMap
        ? adapter
        : new HttpAgentAdapter(adapter.systemId, {
          ...adapter.config,
          modelMap: execution.authorizationModelMap,
        });
      yield* executionAdapter.streamReply(withArtifacts);
    },
  };
}

function createAdapter(systemId: SystemId): ChatBackendAdapter {
  if (systemId === 'letta' && protocol(process.env.LETTA_PROTOCOL) === 'openclaw') {
    return new OpenClawLettaAdapter(openClawLettaConfigFromEnv());
  }

  const config = httpAdapterConfig(systemId);
  if (!config) return mockAdaptersAllowed() ? new MockAdapter(systemId) : new UnavailableAdapter(systemId);
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
  claude: createAdapter('claude'),
  b200: createAdapter('b200'),
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
