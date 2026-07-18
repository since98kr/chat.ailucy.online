import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent, WorkflowRunRecord } from '../shared/contracts.js';
import { buildApp } from './index.js';

process.env.NODE_ENV = 'test';
delete process.env.LETTA_BASE_URL;
delete process.env.HERMES_BASE_URL;

function parseEvents(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

describe('Federated Conversation controller', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-federation-'));
    app = buildApp({ databasePath: join(directory, 'chat.sqlite'), artifactRoot: join(directory, 'artifacts') });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs cross-system workers in parallel and the Hermes coordinator last', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {
        systemId: 'hermes',
        agentId: '[Hermes] Lucy',
        title: 'Federated integration',
        federated: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;

    const draft = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/memory-capsules`,
      payload: {
        sourceSystemId: 'hermes',
        targetSystemId: 'letta',
        title: '개인 일정 판단 문맥',
        content: '개인 일정 판단에는 이번 주 최우선 업무만 전달한다.',
      },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().capsule.status).toBe('draft');
    const capsuleId = draft.json().capsule.id as string;

    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/memory-capsules/${capsuleId}`,
      payload: { status: 'approved' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().capsule).toMatchObject({ status: 'approved', approvedBy: 'tei' });

    const idempotencyKey = 'federated-test-key-001';
    const first = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: {
        content: '구현 관점과 개인 우선순위를 병렬 검토하고 최종 결론을 내려줘.',
        targetAgentIds: ['Xixi', '[Letta] Lucy'],
        workflowMode: 'federated',
        idempotencyKey,
      },
    });
    expect(first.statusCode).toBe(200);
    const events = parseEvents(first.body);
    expect(events.some((event) => event.type === 'workflow.run' && event.run.status === 'completed')).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    const messages = detail.json().conversation.messages as Array<{ authorId: string; content: string }>;
    expect(messages.some((message) => message.authorId === 'Xixi' && message.content.includes('Xixi 원문 결과'))).toBe(true);
    expect(messages.some((message) => message.authorId === '[Letta] Lucy' && message.content.includes('승인된 장기기억'))).toBe(true);
    expect(messages.some((message) => message.authorId === '[Hermes] Lucy' && message.content.includes('종합응답'))).toBe(true);

    const snapshot = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/federation` });
    const run = snapshot.json().federation.runs[0] as WorkflowRunRecord;
    expect(run.status).toBe('completed');
    expect(run.requestedAgentIds).toEqual(['Xixi', '[Letta] Lucy', '[Hermes] Lucy']);
    expect(run.steps.filter((step) => step.agentId !== '[Hermes] Lucy').every((step) => step.parallelGroup === 0)).toBe(true);
    const coordinator = run.steps.find((step) => step.agentId === '[Hermes] Lucy');
    expect(coordinator?.parallelGroup).toBe(1);
    expect(coordinator?.dependsOnStepIds).toHaveLength(2);
    expect(run.steps.every((step) => step.status === 'completed' && step.attempt === 1)).toBe(true);

    const ledger = await app.inject({ method: 'GET', url: `/api/workflows/${run.id}/events` });
    const eventTypes = ledger.json().events.map((event: { type: string }) => event.type);
    expect(eventTypes).toContain('capsule.used');
    expect(eventTypes.at(-1)).toBe('run.completed');

    const messageCount = messages.length;
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages/stream`,
      payload: {
        content: '이 요청은 네트워크 재전송으로 간주되어야 한다.',
        targetAgentIds: ['Xixi', '[Letta] Lucy'],
        workflowMode: 'federated',
        idempotencyKey,
      },
    });
    const duplicateEvents = parseEvents(duplicate.body);
    expect(duplicateEvents[0]).toMatchObject({ type: 'workflow.replayed', runId: run.id });
    const afterDuplicate = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    expect(afterDuplicate.json().conversation.messages).toHaveLength(messageCount);
  });

  it('clones the federated boundary when branching without copying runs', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', federated: true, title: 'Federated source' },
    });
    const sourceId = created.json().conversation.id as string;
    const branched = await app.inject({ method: 'POST', url: `/api/conversations/${sourceId}/branch`, payload: {} });
    expect(branched.statusCode).toBe(201);
    const targetId = branched.json().conversation.id as string;
    const snapshot = await app.inject({ method: 'GET', url: `/api/conversations/${targetId}/federation` });
    expect(snapshot.json().federation.config).toMatchObject({
      conversationId: targetId,
      mode: 'federated',
      memoryPolicy: 'explicit-capsules-only',
    });
    expect(snapshot.json().federation.runs).toEqual([]);
  });

  it('includes capsules and workflow evidence in Markdown export', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', federated: true, title: 'Audit export' },
    });
    const id = created.json().conversation.id as string;
    const capsule = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/memory-capsules`,
      payload: { sourceSystemId: 'letta', targetSystemId: 'hermes', title: '승인 문맥', content: '필요한 사실만 전달한다.' },
    });
    await app.inject({ method: 'PATCH', url: `/api/memory-capsules/${capsule.json().capsule.id}`, payload: { status: 'approved' } });
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '검토해줘.', targetAgentIds: ['Lynn'], workflowMode: 'federated', idempotencyKey: 'audit-export-key' },
    });
    const exported = await app.inject({ method: 'GET', url: `/api/conversations/${id}/export/markdown` });
    expect(exported.body).toContain('## Memory Capsules');
    expect(exported.body).toContain('explicit-capsules-only');
    expect(exported.body).toContain('## Workflow runs');
    expect(exported.body).toContain('audit-export-key');
  });
});
