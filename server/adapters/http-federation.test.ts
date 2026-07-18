import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AgentRecord,
  ConversationParticipantRecord,
  ConversationRecord,
  MemoryCapsuleRecord,
  MessageRecord,
} from '../../shared/contracts.js';
import { HttpAgentAdapter } from './http.js';

const timestamp = '2026-07-18T00:00:00.000Z';
let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = null;
});

async function startServer(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const agents: AgentRecord[] = [
  {
    id: '[Letta] Lucy', systemId: 'letta', displayName: '[Letta] Lucy', shortName: 'Lucy',
    role: 'Personal', description: '', capabilities: ['memory'], enabled: true,
    directChatEnabled: true, isLead: true, sortOrder: 10, createdAt: timestamp, updatedAt: timestamp,
  },
  {
    id: '[Hermes] Lucy', systemId: 'hermes', displayName: '[Hermes] Lucy', shortName: 'Lucy',
    role: 'Lead', description: '', capabilities: ['orchestration'], enabled: true,
    directChatEnabled: true, isLead: true, sortOrder: 10, createdAt: timestamp, updatedAt: timestamp,
  },
];
const conversation: ConversationRecord = {
  id: 'conversation-federated', systemId: 'hermes', agentId: '[Hermes] Lucy', title: 'Federated',
  preview: '', status: 'active', pinned: false, createdAt: timestamp, updatedAt: timestamp,
  lastReadMessageId: null, draft: '', branchedFromConversationId: null, branchedFromMessageId: null,
};
const userMessage: MessageRecord = {
  id: 'message-federated', conversationId: conversation.id, role: 'user', authorId: 'tei', content: '교차 검토',
  state: 'complete', parentMessageId: null, createdAt: timestamp, updatedAt: timestamp,
};
const participants: ConversationParticipantRecord[] = [{
  conversationId: conversation.id, agentId: '[Hermes] Lucy', role: 'lead', state: 'active',
  addedAt: timestamp, updatedAt: timestamp, agent: agents[1],
}];
const approvedCapsule: MemoryCapsuleRecord = {
  id: 'capsule-1', conversationId: conversation.id, sourceSystemId: 'hermes', targetSystemId: 'letta',
  title: 'Approved context', content: '승인된 최소 문맥', status: 'approved', sourceMessageIds: [], createdBy: 'tei',
  approvedBy: 'tei', approvedAt: timestamp, revokedAt: null, createdAt: timestamp, updatedAt: timestamp,
};

describe('HttpAgentAdapter federation payload', () => {
  it('forwards workflow identity, agents, and target-specific approved capsules', async () => {
    let received: Record<string, unknown> = {};
    const baseUrl = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end('{"delta":"ok"}\n');
      });
    });
    const adapter = new HttpAgentAdapter('letta', {
      baseUrl, chatPath: '/chat', healthPath: '/health', timeoutMs: 2_000,
    });
    const chunks = [];
    for await (const item of adapter.streamReply({
      conversation,
      userMessage,
      history: [userMessage],
      targetAgentId: '[Letta] Lucy',
      routingMode: 'team',
      participants,
      federatedAgents: agents,
      memoryCapsules: [approvedCapsule],
      workflowRunId: 'workflow-run-1',
    })) chunks.push(item);

    expect(chunks).toEqual([{ type: 'delta', delta: 'ok' }]);
    expect(received).toMatchObject({
      system_id: 'letta',
      agent_id: '[Letta] Lucy',
      metadata: {
        workflow_run_id: 'workflow-run-1',
        memory_policy: 'explicit-capsules-only',
      },
    });
    expect(received['memory_capsules']).toEqual([expect.objectContaining({
      capsule_id: 'capsule-1',
      source_system_id: 'hermes',
      target_system_id: 'letta',
      content: '승인된 최소 문맥',
    })]);
    expect(received['federated_agents']).toHaveLength(2);
  });
});
