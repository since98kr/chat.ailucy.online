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
  it('does not tie navigation to AbortController lifetime', () => {
    expect(source).not.toContain('cancelActiveStreamForNavigation');
    expect(source).toContain('runControllersRef = useRef<Map<string, AbortController>>(new Map())');
    expect(source).not.toContain('abortRef.current?.abort()');

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

  it('binds stream events and cancellation to the owning Conversation', () => {
    expect(source).toContain('runControllersRef.current.set(conversation.id, controller)');
    expect(source).toContain('handleStreamEventForConversation(conversation.id, event)');
    expect(source).toContain('activeIdRef.current === conversationId');

    const stopBody = functionBody('stopStreaming', 'uploadFiles');
    expect(stopBody).toContain('runControllersRef.current.get(conversationId)');
    expect(stopBody).toContain('controller.abort()');
    expect(stopBody).toContain('runControllersRef.current.delete(conversationId)');
  });

  it('derives busy/status state from the visible Conversation only', () => {
    expect(source).toContain('streamingConversationIds.has(activeConversationId)');
    expect(source).toContain('runStatusByConversation[activeConversationId]');
  });
});
