import type {
  ArtifactDeliveryRecord,
  ArtifactDeliveryState,
  ArtifactRecord,
  StreamEvent,
  SystemId,
} from '../shared/contracts.js';

export function artifactDeliveryEvent(input: {
  runId: string;
  messageId: string;
  agentId: string;
  systemId: SystemId;
  artifacts: ArtifactRecord[];
  state: ArtifactDeliveryState;
  detail?: string | null;
}): StreamEvent {
  const delivery: ArtifactDeliveryRecord = {
    runId: input.runId,
    messageId: input.messageId,
    agentId: input.agentId,
    systemId: input.systemId,
    artifactIds: input.artifacts.map((artifact) => artifact.id),
    state: input.state,
    detail: input.detail ?? null,
  };
  return { type: 'artifacts.delivery', delivery };
}

export function classifyArtifactDeliveryFailure(error: unknown): {
  state: Extract<ArtifactDeliveryState, 'unsupported' | 'failed'>;
  detail: string;
} {
  const detail = error instanceof Error ? error.message : 'Unknown artifact delivery error';
  const normalized = detail.toLowerCase();
  const unsupported = normalized.includes('does not support attachment type')
    || normalized.includes('contains no extractable text')
    || normalized.includes('ocr is not available')
    || normalized.includes('unsupported attachment type');
  return { state: unsupported ? 'unsupported' : 'failed', detail };
}
