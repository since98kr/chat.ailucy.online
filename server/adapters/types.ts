import type { ConversationRecord, MessageRecord, SystemId } from '../../shared/contracts.js';

export type AdapterStreamItem =
  | { type: 'status'; status: string }
  | { type: 'delta'; delta: string };

export interface AdapterRequest {
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  history: MessageRecord[];
  signal?: AbortSignal;
}

export interface ChatBackendAdapter {
  readonly systemId: SystemId;
  health(): Promise<{ ok: boolean; detail: string }>;
  streamReply(request: AdapterRequest): AsyncGenerator<AdapterStreamItem>;
}
