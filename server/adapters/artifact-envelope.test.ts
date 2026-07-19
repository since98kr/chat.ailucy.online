import { describe, expect, it } from 'vitest';
import type { ConversationRecord, MessageRecord } from '../../shared/contracts.js';
import {
  ARTIFACT_ENVELOPE_CLOSE,
  ARTIFACT_ENVELOPE_OPEN,
  ARTIFACT_ENVELOPE_SYSTEM_MESSAGE,
  ArtifactEnvelopeAccumulator,
  wrapArtifactEnvelopeFallback,
} from './artifact-envelope.js';
import type { AdapterRequest, AdapterStreamItem, ChatBackendAdapter } from './types.js';

const timestamp = '2026-07-19T00:00:00.000Z';
const conversation: ConversationRecord = {
  id: 'conversation-envelope',
  systemId: 'hermes',
  agentId: '[Hermes] Lucy',
  title: 'Artifact envelope',
  preview: '',
  status: 'active',
  pinned: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastReadMessageId: null,
  draft: '',
  branchedFromConversationId: null,
  branchedFromMessageId: null,
};
const userMessage: MessageRecord = {
  id: 'message-envelope',
  conversationId: conversation.id,
  role: 'user',
  authorId: 'tei',
  content: '결과 파일을 반환하세요.',
  state: 'complete',
  parentMessageId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function request(): AdapterRequest {
  return {
    conversation,
    userMessage,
    history: [userMessage],
    targetAgentId: '[Hermes] Lucy',
    routingMode: 'direct',
    participants: [],
  };
}

function text(items: AdapterStreamItem[]) {
  return items.filter((item) => item.type === 'delta').map((item) => item.type === 'delta' ? item.delta : '').join('');
}

describe('ArtifactEnvelopeAccumulator', () => {
  it('parses an artifact envelope split across arbitrary streaming chunks', () => {
    const accumulator = new ArtifactEnvelopeAccumulator();
    const source = [
      '완료했습니다.\n',
      ARTIFACT_ENVELOPE_OPEN,
      '{"filename":"qa-result.txt","mime_type":"text/plain","content_text":"INLINE_MARKER"}',
      ARTIFACT_ENVELOPE_CLOSE,
      '\n다운로드할 수 있습니다.',
    ].join('');
    const items: AdapterStreamItem[] = [];
    for (const chunk of source.match(/.{1,7}/gs) ?? []) items.push(...accumulator.ingest(chunk));
    items.push(...accumulator.finish());

    expect(text(items)).toBe('완료했습니다.\n\n다운로드할 수 있습니다.');
    expect(items.find((item) => item.type === 'artifact')).toEqual({
      type: 'artifact',
      artifact: {
        filename: 'qa-result.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('INLINE_MARKER', 'utf8').toString('base64'),
      },
    });
  });

  it('drops Hermes internal progress pseudo-content', () => {
    const accumulator = new ArtifactEnvelopeAccumulator();
    expect(accumulator.ingest('event: hermes.tool.progress')).toEqual([]);
    expect(accumulator.ingest('사용자에게 보이는 답변')).toEqual([]);
    expect(text(accumulator.finish())).toBe('사용자에게 보이는 답변');
  });

  it('rejects an envelope that tries to return a local path immediately', () => {
    const accumulator = new ArtifactEnvelopeAccumulator();
    expect(() => accumulator.ingest(`${ARTIFACT_ENVELOPE_OPEN}{"filename":"unsafe.txt","mime_type":"text/plain","content_text":"x","path":"/tmp/unsafe.txt"}${ARTIFACT_ENVELOPE_CLOSE}`))
      .toThrow('must not contain path');
  });

  it('rejects an unfinished envelope instead of leaking partial JSON', () => {
    const accumulator = new ArtifactEnvelopeAccumulator();
    accumulator.ingest(`${ARTIFACT_ENVELOPE_OPEN}{"filename":"broken.txt"`);
    expect(() => accumulator.finish()).toThrow('missing its closing marker');
  });
});

describe('wrapArtifactEnvelopeFallback', () => {
  it('injects the fallback contract and returns inline artifacts without trusting paths', async () => {
    const captured: { request?: AdapterRequest } = {};
    const inner: ChatBackendAdapter = {
      systemId: 'hermes',
      async health() {
        return { ok: true, mode: 'mock', detail: 'ready' };
      },
      async *streamReply(input) {
        captured.request = input;
        yield { type: 'status', status: 'running' };
        yield { type: 'delta', delta: `${ARTIFACT_ENVELOPE_OPEN}{"filename":"result.md",` };
        yield { type: 'delta', delta: '"mime_type":"text/markdown","content_text":"# Result"}' };
        yield { type: 'delta', delta: ARTIFACT_ENVELOPE_CLOSE };
        yield { type: 'delta', delta: '완료' };
      },
    };

    const items: AdapterStreamItem[] = [];
    for await (const item of wrapArtifactEnvelopeFallback(inner).streamReply(request())) items.push(item);

    expect(captured.request?.history[0]).toMatchObject({
      role: 'system',
      authorId: 'chat-v2',
      content: ARTIFACT_ENVELOPE_SYSTEM_MESSAGE,
    });
    expect(items).toContainEqual({ type: 'status', status: 'running' });
    expect(items).toContainEqual({
      type: 'artifact',
      artifact: {
        filename: 'result.md',
        mimeType: 'text/markdown',
        contentBase64: Buffer.from('# Result', 'utf8').toString('base64'),
      },
    });
    expect(text(items)).toBe('완료');
  });

  it('rejects duplicate native and envelope artifacts', async () => {
    const inner: ChatBackendAdapter = {
      systemId: 'hermes',
      async health() {
        return { ok: true, mode: 'mock', detail: 'ready' };
      },
      async *streamReply() {
        yield {
          type: 'artifact',
          artifact: { filename: 'native.txt', mimeType: 'text/plain', contentBase64: 'bmF0aXZl' },
        };
        yield {
          type: 'delta',
          delta: `${ARTIFACT_ENVELOPE_OPEN}{"filename":"fallback.txt","mime_type":"text/plain","content_text":"fallback"}${ARTIFACT_ENVELOPE_CLOSE}`,
        };
      },
    };

    const consume = async () => {
      for await (const _item of wrapArtifactEnvelopeFallback(inner).streamReply(request())) {
        // Consume the stream to surface validation errors.
      }
    };
    await expect(consume()).rejects.toThrow('both a native artifact and an artifact envelope');
  });
});
