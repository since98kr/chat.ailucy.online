import type { MessageRecord } from '../../shared/contracts.js';
import { parseGeneratedArtifactArguments } from './openai-artifact-tool.js';
import type { AdapterRequest, AdapterStreamItem, ChatBackendAdapter } from './types.js';

export const ARTIFACT_ENVELOPE_OPEN = '<CHAT_V2_ARTIFACT>';
export const ARTIFACT_ENVELOPE_CLOSE = '</CHAT_V2_ARTIFACT>';

const INTERNAL_HERMES_PROGRESS = 'event: hermes.tool.progress';
const MARKER_TAIL_LENGTH = Math.max(ARTIFACT_ENVELOPE_OPEN.length, ARTIFACT_ENVELOPE_CLOSE.length) - 1;

export const ARTIFACT_ENVELOPE_SYSTEM_MESSAGE = [
  'Chat V2 generated-file contract:',
  '- When the user asks you to create, return, download, or attach a file, use the return_artifact function tool when it is available.',
  '- If return_artifact is unavailable, do not write a local file and do not return a filesystem path or remote URL.',
  `- Instead emit one ${ARTIFACT_ENVELOPE_OPEN}...${ARTIFACT_ENVELOPE_CLOSE} block per file.`,
  '- The block body must be one JSON object with only filename, mime_type, and exactly one of content_text or content_base64.',
  '- Do not use Markdown fences around the block. Text outside the block is shown as the assistant response.',
  `Example: ${ARTIFACT_ENVELOPE_OPEN}{"filename":"result.txt","mime_type":"text/plain","content_text":"hello"}${ARTIFACT_ENVELOPE_CLOSE}`,
].join('\n');

export class ArtifactEnvelopeAccumulator {
  private buffer = '';
  private insideEnvelope = false;

  ingest(delta: string): AdapterStreamItem[] {
    if (delta.trim() === INTERNAL_HERMES_PROGRESS) return [];
    this.buffer += delta;
    return this.drain(false);
  }

  finish(): AdapterStreamItem[] {
    return this.drain(true);
  }

  private drain(final: boolean): AdapterStreamItem[] {
    const items: AdapterStreamItem[] = [];

    while (true) {
      if (this.insideEnvelope) {
        const closeIndex = this.buffer.indexOf(ARTIFACT_ENVELOPE_CLOSE);
        if (closeIndex < 0) {
          if (final) throw new Error('Generated artifact envelope is missing its closing marker');
          return items;
        }
        const payload = this.buffer.slice(0, closeIndex).trim();
        if (!payload) throw new Error('Generated artifact envelope is empty');
        items.push({ type: 'artifact', artifact: parseGeneratedArtifactArguments(payload) });
        this.buffer = this.buffer.slice(closeIndex + ARTIFACT_ENVELOPE_CLOSE.length);
        this.insideEnvelope = false;
        continue;
      }

      const openIndex = this.buffer.indexOf(ARTIFACT_ENVELOPE_OPEN);
      const closeIndex = this.buffer.indexOf(ARTIFACT_ENVELOPE_CLOSE);
      if (closeIndex >= 0 && (openIndex < 0 || closeIndex < openIndex)) {
        throw new Error('Generated artifact envelope has an unexpected closing marker');
      }
      if (openIndex >= 0) {
        const visible = this.buffer.slice(0, openIndex);
        if (visible) items.push({ type: 'delta', delta: visible });
        this.buffer = this.buffer.slice(openIndex + ARTIFACT_ENVELOPE_OPEN.length);
        this.insideEnvelope = true;
        continue;
      }

      if (final) {
        if (this.buffer) items.push({ type: 'delta', delta: this.buffer });
        this.buffer = '';
        return items;
      }

      const safeLength = Math.max(0, this.buffer.length - MARKER_TAIL_LENGTH);
      if (safeLength > 0) {
        items.push({ type: 'delta', delta: this.buffer.slice(0, safeLength) });
        this.buffer = this.buffer.slice(safeLength);
      }
      return items;
    }
  }
}

function systemMessage(request: AdapterRequest): MessageRecord {
  return {
    id: `${request.userMessage.id}:chat-v2-artifact-contract`,
    conversationId: request.conversation.id,
    role: 'system',
    authorId: 'chat-v2',
    content: ARTIFACT_ENVELOPE_SYSTEM_MESSAGE,
    state: 'complete',
    parentMessageId: null,
    createdAt: request.userMessage.createdAt,
    updatedAt: request.userMessage.createdAt,
  };
}

export function wrapArtifactEnvelopeFallback(adapter: ChatBackendAdapter): ChatBackendAdapter {
  return {
    systemId: adapter.systemId,
    health: () => adapter.health(),
    async *streamReply(request: AdapterRequest) {
      const accumulator = new ArtifactEnvelopeAccumulator();
      let nativeArtifactSeen = false;
      let envelopeArtifactSeen = false;
      const withContract = {
        ...request,
        history: [systemMessage(request), ...request.history],
      };

      for await (const item of adapter.streamReply(withContract)) {
        if (item.type === 'delta') {
          for (const parsed of accumulator.ingest(item.delta)) {
            if (parsed.type === 'artifact') {
              if (nativeArtifactSeen) throw new Error('Backend returned both a native artifact and an artifact envelope');
              envelopeArtifactSeen = true;
            }
            yield parsed;
          }
          continue;
        }
        if (item.type === 'artifact') {
          if (envelopeArtifactSeen) throw new Error('Backend returned both an artifact envelope and a native artifact');
          nativeArtifactSeen = true;
        }
        yield item;
      }

      for (const parsed of accumulator.finish()) {
        if (parsed.type === 'artifact') {
          if (nativeArtifactSeen) throw new Error('Backend returned both a native artifact and an artifact envelope');
          envelopeArtifactSeen = true;
        }
        yield parsed;
      }
    },
  };
}
