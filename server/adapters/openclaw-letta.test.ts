import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationParticipantRecord, ConversationRecord, MessageRecord } from '../../shared/contracts.js';
import { OpenClawLettaAdapter } from './openclaw-letta.js';

const timestamp = '2026-09-04T00:00:00.000Z';
const conversation: ConversationRecord = {
  id: 'openclaw-terminal-conversation',
  systemId: 'letta',
  agentId: '[Letta] Lucy',
  title: 'Terminal frame regression',
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
  id: 'openclaw-terminal-message',
  conversationId: conversation.id,
  role: 'user',
  authorId: 'tei',
  content: 'terminal frame test',
  state: 'complete',
  parentMessageId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const participants: ConversationParticipantRecord[] = [{
  conversationId: conversation.id,
  agentId: '[Letta] Lucy',
  role: 'lead',
  state: 'active',
  addedAt: timestamp,
  updatedAt: timestamp,
  agent: {
    id: '[Letta] Lucy',
    systemId: 'letta',
    displayName: '[Letta] Lucy',
    shortName: 'Lucy',
    role: 'Lead Orchestrator',
    description: '',
    capabilities: ['orchestration'],
    enabled: true,
    directChatEnabled: true,
    isLead: true,
    sortOrder: 10,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
}];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenClawLettaAdapter stream termination', () => {
  it('stops at the OpenAI [DONE] frame instead of waiting for transport EOF', async () => {
    let cancelled = false;
    let emitted = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) return;
        emitted = true;
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"CHAT_OK"},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
        ));
        closeTimer = setTimeout(() => controller.close(), 1_500);
      },
      cancel() {
        cancelled = true;
        if (closeTimer) clearTimeout(closeTimer);
      },
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));

    const adapter = new OpenClawLettaAdapter({
      baseUrl: 'http://openclaw.invalid',
      chatPath: '/v1/chat/completions',
      healthPath: '/health',
      agentTarget: 'openclaw/main',
      sessionPrefix: 'test',
      timeoutMs: 2_000,
      maxArtifactBytes: 1024,
      maxArtifactTotalBytes: 2048,
      artifactToolEnabled: false,
    });

    const started = performance.now();
    const items = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
      targetAgentId: '[Letta] Lucy',
      routingMode: 'direct',
      participants,
    })) items.push(item);
    const elapsedMs = performance.now() - started;

    expect(items).toEqual([{ type: 'delta', delta: 'CHAT_OK' }]);
    expect(cancelled).toBe(true);
    expect(elapsedMs).toBeLessThan(500);
  });
});
