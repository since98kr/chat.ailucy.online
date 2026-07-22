import { describe, expect, it } from 'vitest';
import type { ArtifactRecord } from '../shared/contracts.js';
import { artifactDeliveryEvent, classifyArtifactDeliveryFailure } from './artifact-delivery.js';

const artifact: ArtifactRecord = {
  id: 'artifact-1',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  filename: 'scan.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 128,
  storagePath: '/private/not-exposed',
  createdAt: '2026-07-19T00:00:00.000Z',
};

describe('artifact delivery lifecycle', () => {
  it('emits safe public delivery metadata without storage paths', () => {
    const event = artifactDeliveryEvent({
      runId: 'run-1',
      messageId: 'message-1',
      agentId: 'Gemma',
      systemId: 'hermes',
      artifacts: [artifact],
      state: 'delivering',
    });

    expect(event).toEqual({
      type: 'artifacts.delivery',
      delivery: {
        runId: 'run-1',
        messageId: 'message-1',
        agentId: 'Gemma',
        systemId: 'hermes',
        artifactIds: ['artifact-1'],
        state: 'delivering',
        detail: null,
      },
    });
    expect(JSON.stringify(event)).not.toContain('storagePath');
    expect(JSON.stringify(event)).not.toContain('/private/not-exposed');
  });

  it('classifies unsupported formats and missing OCR separately from transport failures', () => {
    expect(classifyArtifactDeliveryFailure(new Error('OpenAI-compatible chat transport does not support attachment type: application/zip')))
      .toMatchObject({ state: 'unsupported' });
    expect(classifyArtifactDeliveryFailure(new Error('Attachment scan.pdf contains no extractable text; OCR is not available for this document')))
      .toMatchObject({ state: 'unsupported' });
    expect(classifyArtifactDeliveryFailure(new Error('Hermes backend 503: unavailable')))
      .toMatchObject({ state: 'failed' });
  });
});
