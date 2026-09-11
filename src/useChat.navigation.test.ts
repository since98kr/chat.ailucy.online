import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./useChat.ts', import.meta.url), 'utf8');

function functionBody(name: string, nextName: string) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`const ${nextName} = useCallback`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('room-scoped chat execution contract', () => {
  it('does not tie room navigation to response cancellation', () => {
    expect(source).not.toContain('cancelActiveStreamForNavigation');
    expect(source).toContain('streamControllersRef = useRef<Map<string, AbortController>>(new Map())');

    const navigationBodies = [
      functionBody('switchSystem', 'switchStatus'),
      functionBody('switchStatus', 'selectConversation'),
      functionBody('selectConversation', 'createConversation'),
      functionBody('createConversation', 'createFederatedConversation'),
      functionBody('createFederatedConversation', 'openAgentConversation'),
      functionBody('openAgentConversation', 'branchConversation'),
      functionBody('branchConversation', 'patchConversation'),
    ];
    for (const body of navigationBodies) expect(body).not.toContain('.abort()');
  });

  it('publishes a visible action owner only after the matching room load wins', () => {
    expect(source).toContain('pendingSelectionRef = useRef<string | null>(null)');
    expect(source).toContain('navigationEpochRef = useRef(0)');
    expect(source).toContain('activeIdRef.current = null');
    expect(source).toContain('navigationEpochRef.current !== navigationEpoch');
    expect(source).toContain('pendingSelectionRef.current !== id');
    expect(source).toContain('activeIdRef.current = detail.id');
  });

  it('keeps same-status selection a no-op instead of detaching the visible owner', () => {
    const body = functionBody('switchStatus', 'selectConversation');
    expect(body).toContain('if (status === selectedStatus) return');
    expect(body).toContain('beginNavigation(null)');
  });

  it('binds streams and explicit Stop to the owning Conversation only', () => {
    expect(source).toContain('streamControllersRef.current.set(conversation.id, controller)');
    expect(source).toContain('handleStreamEvent(conversation.id, event)');
    expect(source).toContain('current?.id === conversationId');

    const stopBody = functionBody('stopStreaming', 'uploadFiles');
    expect(stopBody).toContain('streamControllersRef.current.get(conversationId)?.abort()');
    expect(stopBody).not.toContain('beginNavigation');
  });

  it('derives busy/status/transcript state from the visible Conversation only', () => {
    expect(source).toContain('streamingConversationIds.has(activeConversationId)');
    expect(source).toContain('runStatusByConversation[activeConversationId]');
    expect(source).toContain('transcriptsByConversation[activeConversationId]');
    expect(source).toContain('artifactDeliveriesByConversation[activeConversationId]');
  });
});
