import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../shared/contracts.js';
import { conversationRuntimeIdentity, providerSessionIdentity } from './provider-session-identity.js';

const originalProtocol = process.env.OPENCLAW_PROTOCOL;

function conversation(agentId: string): ConversationRecord {
  return {
    id: 'personal-session-compat',
    systemId: 'openclaw',
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
  if (originalProtocol === undefined) delete process.env.OPENCLAW_PROTOCOL;
  else process.env.OPENCLAW_PROTOCOL = originalProtocol;
});

describe('personal Lucy provider session compatibility', () => {
  it('keeps only the provider-side agent key stable across the retired Letta identity rename', () => {
    process.env.OPENCLAW_PROTOCOL = 'native';
    const legacyProviderIdentity = conversation('[Letta] Lucy');
    const canonical = conversation('[OpenClaw] Lucy');

    expect(providerSessionIdentity(canonical, canonical.agentId)).toBe(
      providerSessionIdentity(legacyProviderIdentity, legacyProviderIdentity.agentId),
    );
    expect(providerSessionIdentity(canonical, canonical.agentId)).toBe(
      'openclaw:personal-session-compat:[Letta] Lucy',
    );
    expect(providerSessionIdentity(canonical, canonical.agentId, 'caller-1')).toBe(
      providerSessionIdentity(legacyProviderIdentity, legacyProviderIdentity.agentId, 'caller-1'),
    );

    const runtimeIdentity = conversationRuntimeIdentity(canonical);
    expect(runtimeIdentity.backendSystem).toBe('openclaw');
    expect(runtimeIdentity.agentId).toBe('[OpenClaw] Lucy');
    expect(runtimeIdentity.sessionIdentity).toBe('openclaw:personal-session-compat:[Letta] Lucy');
  });

  it('uses the dedicated OpenClaw transport session namespace unchanged', () => {
    process.env.OPENCLAW_PROTOCOL = 'openclaw';
    expect(providerSessionIdentity(conversation('[OpenClaw] Lucy'), '[OpenClaw] Lucy')).toBe(
      'agent:main:chat-v2:personal-session-compat',
    );
  });
});