import { describe, expect, it } from 'vitest';
import type { AdapterRequest } from './types.js';
import {
  approvedAdapterCapabilities,
  authorizeSelectedAgentExecution,
  sanitizeRuntimeIdentity,
} from './capability-contract.js';

const timestamp = '2026-07-26T00:00:00.000Z';

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    conversation: {
      id: 'conversation-1', systemId: 'hermes', agentId: '[Hermes] Lucy', title: '', preview: '',
      status: 'active', pinned: false, createdAt: timestamp, updatedAt: timestamp,
      lastReadMessageId: null, draft: '', branchedFromConversationId: null, branchedFromMessageId: null,
    },
    userMessage: {
      id: 'message-1', conversationId: 'conversation-1', role: 'user', authorId: 'user', content: 'hello',
      state: 'complete', parentMessageId: null, createdAt: timestamp, updatedAt: timestamp,
    },
    history: [], targetAgentId: '[Hermes] Lucy', selectedAgentId: '[Hermes] Lucy', routingMode: 'team',
    participants: [
      participant('[Hermes] Lucy', 'lead', ['orchestration']),
      participant('Xixi', 'participant', ['implementation']),
      participant('Lynn', 'participant', ['review']),
    ],
    ...overrides,
  };
}

function participant(id: string, role: 'lead' | 'participant', capabilities: string[], state: 'active' | 'offline' = 'active') {
  return {
    conversationId: 'conversation-1', agentId: id, role, state, addedAt: timestamp, updatedAt: timestamp,
    agent: {
      id, systemId: 'hermes' as const, displayName: id, shortName: id, role, description: '', capabilities,
      enabled: true, directChatEnabled: true, isLead: role === 'lead', sortOrder: 1, createdAt: timestamp, updatedAt: timestamp,
    },
  };
}

describe('approved adapter capability contract', () => {
  it('authorizes the selected lead and discovers only its approved active subagents', () => {
    expect(approvedAdapterCapabilities(request(), 'hermes')).toEqual({
      selectedAgent: { agentId: '[Hermes] Lucy', capabilities: ['orchestration'] },
      approvedSubagents: [
        { agentId: 'Xixi', capabilities: ['implementation'] },
        { agentId: 'Lynn', capabilities: ['review'] },
      ],
    });
  });

  it('isolates a selected subagent from sibling discovery', () => {
    const selected = request({ targetAgentId: 'Xixi', selectedAgentId: 'Xixi' });
    expect(approvedAdapterCapabilities(selected, 'hermes')).toEqual({
      selectedAgent: { agentId: 'Xixi', capabilities: ['implementation'] },
      approvedSubagents: [],
    });
  });

  it('fails closed when the selected agent is unapproved or offline', () => {
    expect(() => approvedAdapterCapabilities(request({ targetAgentId: 'unknown', selectedAgentId: 'unknown' }), 'hermes'))
      .toThrow('not authorized');
    expect(() => approvedAdapterCapabilities(request({
      participants: [participant('[Hermes] Lucy', 'lead', ['orchestration']), participant('Xixi', 'participant', ['implementation'], 'offline')],
      targetAgentId: 'Xixi', selectedAgentId: 'Xixi',
    }), 'hermes')).toThrow('not authorized');
  });

  it('allows only the selected agent or its explicitly configured runtime target', () => {
    expect(authorizeSelectedAgentExecution('Xixi', 'Xixi', 'implementation-runtime')).toBe('Xixi');
    expect(authorizeSelectedAgentExecution('Xixi', 'implementation-runtime', 'implementation-runtime')).toBe('implementation-runtime');
    expect(() => authorizeSelectedAgentExecution('Xixi', 'Lynn', 'implementation-runtime')).toThrow('does not match selected agent');
  });

  it('strips control characters and rejects empty runtime identity fields', () => {
    expect(sanitizeRuntimeIdentity({ provider: ' hermes\ncli ', model: ' model\t1 ', selectedAgentId: ' Xixi ' }))
      .toEqual({ provider: 'hermescli', model: 'model1', selectedAgentId: 'Xixi' });
    expect(() => sanitizeRuntimeIdentity({ provider: '\n', model: 'model', selectedAgentId: 'Xixi' }))
      .toThrow('provider must be a non-empty printable identifier');
  });
});
