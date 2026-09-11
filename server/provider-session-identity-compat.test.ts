import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../shared/contracts.js';
import { conversationRuntimeIdentity, providerSessionIdentity } from './provider-session-identity.js';

const originalProtocol = process.env.LETTA_PROTOCOL;

function conversation(agentId: string): ConversationRecord {
  return {
    id: 'personal-session-compat',
    systemId: 'letta',
    agentId,
    title: 'Personal Lucy',
    preview: '',
    status: 'active',
    pinned: false,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    lastReadMessageId: null,
    draft: '',
    branchedFromConversationId: null,
    branchedFromMessageId: null,
  };
}

afterEach(() => {
  if (originalProtocol === undefined) delete process.env.LETTA_PROTOCOL;
  else process.env.LETTA_PROTOCOL = originalProtocol;
});

describe('personal Lucy provider session compatibility', () => {
  it('keeps the native provider session key stable across the OpenClaw product identity rename', () => {
    process.env.LETTA_PROTOCOL = 'native';
    const legacy = conversation('[Letta] Lucy');
    const canonical = conversation('[OpenClaw] Lucy');

    expect(providerSessionIdentity(canonical, canonical.agentId)).toBe(
      providerSessionIdentity(legacy, legacy.agentId),
    );
    expect(providerSessionIdentity(canonical, canonical.agentId)).toBe(
      'letta:personal-session-compat:[Letta] Lucy',
    );
    expect(providerSessionIdentity(canonical, canonical.agentId, 'caller-1')).toBe(
      providerSessionIdentity(legacy, legacy.agentId, 'caller-1'),
    );

    const runtimeIdentity = conversationRuntimeIdentity(canonical);
    expect(runtimeIdentity.agentId).toBe('[OpenClaw] Lucy');
    expect(runtimeIdentity.sessionIdentity).toBe('letta:personal-session-compat:[Letta] Lucy');
  });

  it('leaves the dedicated OpenClaw transport session namespace unchanged', () => {
    process.env.LETTA_PROTOCOL = 'openclaw';
    expect(providerSessionIdentity(conversation('[OpenClaw] Lucy'), '[OpenClaw] Lucy')).toBe(
      'agent:main:chat-v2:personal-session-compat',
    );
  });
});
