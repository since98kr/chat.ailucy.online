import type { AdapterHealthRecord, SystemId } from '../../shared/contracts.js';
import type { AdapterRequest, ChatBackendAdapter } from './types.js';
import { wrapArtifactEnvelopeFallback } from './artifact-envelope.js';
import { MockAdapter, UnavailableAdapter } from './mock.js';
import { HttpAgentAdapter, httpAdapterConfig } from './http.js';
import { OpenClawLettaAdapter, openClawLettaConfigFromEnv } from './openclaw-letta.js';
import { augmentNativeArtifactContext } from './native-artifacts.js';
import { wrapProgressSanitizer } from './progress-status.js';

const LEGACY_PERSONAL_LUCY_ID = '[Letta] Lucy';
const OPENCLAW_PERSONAL_LUCY_ID = '[OpenClaw] Lucy';

export function resolvePersonalLucyProviderTarget(
  requestedAgentId: string,
  configuredAgentId?: string,
  modelMap?: Record<string, string>,
) {
  if (requestedAgentId !== OPENCLAW_PERSONAL_LUCY_ID) return undefined;
  return modelMap?.[OPENCLAW_PERSONAL_LUCY_ID]
    ?? modelMap?.[LEGACY_PERSONAL_LUCY_ID]
    ?? configuredAgentId
    ?? LEGACY_PERSONAL_LUCY_ID;
}

export function resolveNativeTargetAgentId(
  requestedAgentId: string,
  conversationAgentId: string,
  configuredAgentId?: string,
  modelMap?: Record<string, string>,
) {
  const requested = requestedAgentId || conversationAgentId;
  const personalLucyTarget = resolvePersonalLucyProviderTarget(requested, configuredAgentId, modelMap);
  return modelMap?.[requested]
    ?? personalLucyTarget
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
  // conversation lead or for the canonical personal Lucy compatibility lane.
  // Arbitrary runtime IDs never become authorized merely because requested.
  const mappedByWrapper = targetAgentId !== requestedAgentId
    && (requestedAgentId === conversationAgentId || requestedAgentId === OPENCLAW_PERSONAL_LUCY_ID);
  const authorizationModelMap = mappedByWrapper
    ? { ...modelMap, [selectedAgentId || requestedAgentId]: targetAgentId }
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

function wrapOpenAiPersonalLucyMapping(
  adapter: HttpAgentAdapter,
  configuredAgentId?: string,
  modelMap?: Record<string, string>,
): ChatBackendAdapter {
  return {
    systemId: adapter.systemId,
    health: () => adapter.health(),
    async *streamReply(request: AdapterRequest) {
      const selectedAgentId = request.selectedAgentId ?? request.targetAgentId;
      const targetAgentId = resolvePersonalLucyProviderTarget(request.targetAgentId, configuredAgentId, modelMap);
      if (!targetAgentId) {
        yield* adapter.streamReply(request);
        return;
      }
      const executionAdapter = new HttpAgentAdapter(adapter.systemId, {
        ...adapter.config,
        // Keep Chat V2 authorization bound to the canonical selected agent,
        // while mapping its provider model/target to the existing runtime ID.
        modelMap: { ...modelMap, [OPENCLAW_PERSONAL_LUCY_ID]: targetAgentId },
      });
      yield* executionAdapter.streamReply({
        ...request,
        selectedAgentId,
        targetAgentId,
      });
    },
  };
}

function createAdapter(systemId: SystemId): ChatBackendAdapter {
  if (systemId === 'letta' && protocol(process.env.LETTA_PROTOCOL) === 'openclaw') {
    return wrapProgressSanitizer(new OpenClawLettaAdapter(openClawLettaConfigFromEnv()));
  }

  const config = httpAdapterConfig(systemId);
  if (!config) {
    return wrapProgressSanitizer(
      mockAdaptersAllowed() ? new MockAdapter(systemId) : new UnavailableAdapter(systemId),
    );
  }
  const httpAdapter = new HttpAgentAdapter(systemId, config);
  const adapter = config.protocol === 'native'
    ? wrapNativeAgentMapping(httpAdapter, config.agentId, config.modelMap)
    : systemId === 'letta'
      ? wrapOpenAiPersonalLucyMapping(httpAdapter, config.agentId, config.modelMap)
      : httpAdapter;
  const artifactAwareAdapter = systemId === 'hermes'
    && config.protocol === 'openai'
    && enabled(process.env.HERMES_ARTIFACT_ENVELOPE_ENABLED)
    ? wrapArtifactEnvelopeFallback(adapter)
    : adapter;
  return wrapProgressSanitizer(artifactAwareAdapter);
}

const adapters: Record<SystemId, ChatBackendAdapter> = {
  letta: createAdapter('letta'),
  hermes: createAdapter('hermes'),
  claude: createAdapter('claude'),
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
