export type ConversationOperatingIntent = 'ordinary' | 'continuation' | 'status' | 'approval';

const CONTINUATION_PHRASES = new Set(['계속해', '계속', '진행해', 'go', '.']);
const STATUS_PHRASES = new Set(['지금 어디까지야', '뭐가 남았어', '왜 안돼', '왜 안 돼']);

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/[?!.]+$/u, '').trim();
}

export function classifyConversationIntent(content: string): ConversationOperatingIntent {
  const normalized = normalize(content);
  if (normalized === '승인') return 'approval';
  if (CONTINUATION_PHRASES.has(normalized) || content.trim() === '.') return 'continuation';
  if (STATUS_PHRASES.has(normalized)) return 'status';
  return 'ordinary';
}
