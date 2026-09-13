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
        reason: null,
        verificationPlan: null,
        rollbackPlan: null,
        state: 'pending',
      }),
    ]);
    expect(mapOpenClawPendingApprovals(context, records, 'other')).toEqual([]);
    expect(mapOpenClawPendingApprovals(context, records)).toEqual([]);
    expect(mapOpenClawPendingApprovals(context, records, '   ')).toEqual([]);
  });

  it('preserves bounded backend-owned reason, verification, and rollback without inventing missing values', () => {
    const [mapped] = mapOpenClawPendingApprovals(context, [{
      approvalKind: 'exec',
      id: 'approval-explained',
      createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
      request: {
        sessionKey: 'chat-v2:conversation-1',
        agentId: 'main',
        commandPreview: 'restart bounded worker',
        reason: '  Apply\nvalidated source change  ',
        metadata: {
          verificationPlan: 'Confirm health endpoint and exact version.',
        },
      },
      metadata: {
        rollback: 'Restore the previous versioned container.',
      },
    }], 'main');

    expect(mapped).toMatchObject({
      approvalId: 'approval-explained',
      summary: 'restart bounded worker',
      reason: 'Apply validated source change',
      verificationPlan: 'Confirm health endpoint and exact version.',
      rollbackPlan: 'Restore the previous versioned container.',
    });
  });

  it('bounds explanation metadata and keeps empty values explicitly unknown', () => {
    const [mapped] = mapOpenClawPendingApprovals(context, [{
      approvalKind: 'exec',
      id: 'approval-bounded',
      createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
      reason: 'x'.repeat(900),
      verificationPlan: '   ',
      request: {
        sessionKey: 'chat-v2:conversation-1',
        agentId: 'main',
        commandPreview: 'bounded action',
      },
    }], 'main');

    expect(mapped.reason).toHaveLength(500);
    expect(mapped.verificationPlan).toBeNull();
    expect(mapped.rollbackPlan).toBeNull();
  });

  it('normalizes gateway urls and agent aliases without inventing an agent id', () => {
    expect(gatewayWebSocketUrl('http://127.0.0.1:18789/v1/chat/completions')).toBe('ws://127.0.0.1:18789');
    expect(gatewayWebSocketUrl('https://gateway.example.test/path?q=1')).toBe('wss://gateway.example.test');
    expect(openClawRuntimeAgentId('openclaw/main')).toBe('main');
    expect(openClawRuntimeAgentId('agent:lucy')).toBe('lucy');
    expect(openClawRuntimeAgentId('openclaw/default')).toBeUndefined();
  });
});
