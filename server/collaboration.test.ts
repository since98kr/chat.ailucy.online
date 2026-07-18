import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../shared/contracts.js';
import { buildApp } from './index.js';

process.env.NODE_ENV = 'test';
delete process.env.LETTA_BASE_URL;
delete process.env.HERMES_BASE_URL;

function streamEvents(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

describe('Hermes collaboration foundation', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'chat-v2-collaboration-'));
    app = buildApp({
      databasePath: join(directory, 'chat.sqlite'),
      artifactRoot: join(directory, 'artifacts'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('exposes the persistent agent registry and supports direct subagent Conversations', async () => {
    const roster = await app.inject({ method: 'GET', url: '/api/agents?systemId=hermes' });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().agents.map((agent: { id: string }) => agent.id)).toEqual([
      '[Hermes] Lucy',
      'Xixi',
      'Lynn',
      'Gemma',
    ]);
    expect(roster.json().agents.find((agent: { id: string }) => agent.id === 'Xixi')).toMatchObject({
      enabled: true,
      directChatEnabled: true,
      capabilities: expect.arrayContaining(['implementation']),
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: 'Xixi', title: 'Xixi 직접 구현 대화' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().conversation.id as string;

    const participants = await app.inject({ method: 'GET', url: `/api/conversations/${id}/participants` });
    expect(participants.json().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'Xixi', role: 'lead' }),
      expect.objectContaining({ agentId: '[Hermes] Lucy', role: 'observer' }),
    ]));

    const response = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: 'API 경계를 구현해줘.' },
    });
    const events = streamEvents(response.body);
    expect(events.find((event) => event.type === 'routing.resolved')).toMatchObject({
      routing: { mode: 'direct', targetAgentIds: ['Xixi'] },
    });
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    expect(detail.json().conversation.messages.at(-1)).toMatchObject({ authorId: 'Xixi', state: 'complete' });
    expect(detail.json().conversation.messages.at(-1).content).toContain('Xixi 원문 결과');
  });

  it('routes explicit mentions to subagents and preserves each original output before Lucy synthesis', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: '팀 협업 검증' },
    });
    const id = created.json().conversation.id as string;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '@Xixi 구현안을 만들고 @Lynn 독립 검토해줘.' },
    });
    expect(streamed.statusCode).toBe(200);
    const events = streamEvents(streamed.body);
    expect(events.find((event) => event.type === 'routing.resolved')).toMatchObject({
      routing: {
        mode: 'team',
        mentionedAgentIds: ['Xixi', 'Lynn'],
        targetAgentIds: ['Xixi', 'Lynn', '[Hermes] Lucy'],
      },
    });
    expect(events.filter((event) => event.type === 'message.created')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(3);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    const messages = detail.json().conversation.messages as Array<{ role: string; authorId: string; content: string }>;
    expect(messages.map((message) => message.authorId)).toEqual(['tei', 'Xixi', 'Lynn', '[Hermes] Lucy']);
    expect(messages[1].content).toContain('Xixi 원문 결과');
    expect(messages[2].content).toContain('Lynn 독립 검토 원문');
    expect(messages[3].content).toContain('종합응답');

    const participants = await app.inject({ method: 'GET', url: `/api/conversations/${id}/participants` });
    expect(participants.json().participants.map((item: { agentId: string }) => item.agentId)).toEqual([
      '[Hermes] Lucy',
      'Xixi',
      'Lynn',
    ]);

    const activities = await app.inject({ method: 'GET', url: `/api/conversations/${id}/team-activity` });
    expect(activities.json().activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'Xixi', type: 'output' }),
      expect.objectContaining({ agentId: 'Lynn', type: 'output' }),
      expect.objectContaining({ agentId: '[Hermes] Lucy', type: 'output' }),
    ]));
  });

  it('persists participant controls, previews routing, and clones participants on branch', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy' },
    });
    const id = created.json().conversation.id as string;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/conversations/${id}/participants`,
      payload: { leadAgentId: '[Hermes] Lucy', agentIds: ['Gemma'] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().participants.map((item: { agentId: string }) => item.agentId)).toEqual([
      '[Hermes] Lucy',
      'Gemma',
    ]);

    const preview = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/routing/preview`,
      payload: { content: '@Gemma 첨부 이미지를 분석해줘.' },
    });
    expect(preview.json().routing).toMatchObject({
      mode: 'team',
      targetAgentIds: ['Gemma', '[Hermes] Lucy'],
    });

    const branch = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/branch`,
      payload: { title: 'Gemma 분석 분기' },
    });
    expect(branch.statusCode).toBe(201);
    const branchId = branch.json().conversation.id as string;
    const participants = await app.inject({ method: 'GET', url: `/api/conversations/${branchId}/participants` });
    expect(participants.json().participants.map((item: { agentId: string }) => item.agentId)).toEqual([
      '[Hermes] Lucy',
      'Gemma',
    ]);
  });

  it('includes participants and team activity in Markdown evidence export', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { systemId: 'hermes', agentId: '[Hermes] Lucy', title: '증거 내보내기' },
    });
    const id = created.json().conversation.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages/stream`,
      payload: { content: '@Xixi 구현 근거를 남겨줘.' },
    });
    const exported = await app.inject({ method: 'GET', url: `/api/conversations/${id}/export/markdown` });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain('## Participants');
    expect(exported.body).toContain('Xixi — participant');
    expect(exported.body).toContain('## Team activity');
    expect(exported.body).toContain('original output was preserved');
  });
});
