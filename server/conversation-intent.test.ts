import { describe, expect, it } from 'vitest';
import { classifyConversationIntent } from './conversation-intent.js';

describe('conversation control intent', () => {
  it.each(['계속해', '진행해', 'go', '.'])('binds %s as continuation', (value) => {
    expect(classifyConversationIntent(value)).toBe('continuation');
  });

  it.each(['지금 어디까지야?', '뭐가 남았어?', '왜 안돼?'])('binds %s as status without replacing the task', (value) => {
    expect(classifyConversationIntent(value)).toBe('status');
  });

  it('binds only a bare approval as approval control intent', () => {
    expect(classifyConversationIntent('승인')).toBe('approval');
    expect(classifyConversationIntent('승인 기준을 설명해줘')).toBe('ordinary');
  });
});
