import { describe, expect, it } from 'vitest';
import {
  gatewayWebSocketUrl,
  mapOpenClawPendingApprovals,
  openClawRuntimeAgentId,
} from './openclaw-approval.js';
import { createConversationOperatingContext } from '../shared/conversation-operating-context.js';

const context = createConversationOperatingContext({
  conversationId: 'conversation-1',
  backendSystem: 'letta',
  agentId: '[Letta] Lucy',
  sessionIdentity: 'chat-v2:conversation-1',
});

describe('OpenClaw approval contract', () => {
  it('maps only the exact current session and expected runtime agent', () => {
    const records = [
      {
        approvalKind: 'exec',
        id: 'approval-current',
        createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
        expiresAtMs: Date.parse('2026-09-01T01:00:00Z'),
        request: {
          sessionKey: 'chat-v2:conversation-1',
          agentId: 'main',
          commandPreview: 'safe current action',
        },
      },
      {
        approvalKind: 'exec',
        id: 'approval-foreign',
        createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
        request: { sessionKey: 'chat-v2:other', agentId: 'main', command: 'foreign' },
      },
    ];
    expect(mapOpenClawPendingApprovals(context, records, 'main')).toEqual([
      expect.objectContaining({
        approvalId: 'approval-current',
        sessionIdentity: 'chat-v2:conversation-1',
        summary: 'safe current action',
        state: 'pending',
      }),
    ]);
    expect(mapOpenClawPendingApprovals(context, records, 'other')).toEqual([]);
    expect(mapOpenClawPendingApprovals(context, records)).toEqual([]);
    expect(mapOpenClawPendingApprovals(context, records, '   ')).toEqual([]);
  });

  it('normalizes gateway urls and agent aliases without inventing an agent id', () => {
    expect(gatewayWebSocketUrl('http://127.0.0.1:18789/v1/chat/completions')).toBe('ws://127.0.0.1:18789');
    expect(gatewayWebSocketUrl('https://gateway.example.test/path?q=1')).toBe('wss://gateway.example.test');
    expect(openClawRuntimeAgentId('openclaw/main')).toBe('main');
    expect(openClawRuntimeAgentId('agent:lucy')).toBe('lucy');
    expect(openClawRuntimeAgentId('openclaw/default')).toBeUndefined();
  });
});
