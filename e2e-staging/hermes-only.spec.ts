import { expect, request as apiRequest, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

type ApiContext = Awaited<ReturnType<typeof apiRequest.newContext>>;
type Agent = {
  id: string;
  systemId: 'letta' | 'hermes';
  displayName: string;
  shortName: string;
  role: string;
  description: string;
  capabilities: string[];
  enabled: boolean;
  directChatEnabled: boolean;
  isLead: boolean;
  sortOrder: number;
};
type StreamEvent = {
  type: string;
  delta?: string;
  error?: string;
  message?: { content?: string; authorId?: string };
  agentId?: string;
  delivery?: { state: string; agentId: string; systemId: string; artifactIds: string[] };
};

function authHeaders() {
  const clientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) throw new Error('Both Cloudflare Access credentials are required');
    return { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret };
  }
  const email = process.env.CHAT_STAGING_EMAIL?.trim();
  if (!email) throw new Error('CHAT_STAGING_EMAIL or Cloudflare Access credentials are required');
  return { 'Cf-Access-Authenticated-User-Email': email };
}

async function context() {
  const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
  return apiRequest.newContext({
    baseURL,
    extraHTTPHeaders: { ...authHeaders(), Origin: new URL(baseURL).origin },
  });
}

async function createConversation(api: ApiContext, agentId: string, title: string) {
  const response = await api.post('/api/conversations', { data: { systemId: 'hermes', agentId, title } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { conversation: { id: string } }).conversation.id;
}

async function removeConversation(api: ApiContext, id: string) {
  await api.patch(`/api/conversations/${id}`, { data: { status: 'trashed' } });
  await api.delete(`/api/conversations/${id}`);
}

async function send(api: ApiContext, id: string, content: string, artifactIds: string[] = []) {
  const response = await api.post(`/api/conversations/${id}/messages/stream`, {
    data: { content, artifactIds, clientMessageId: randomUUID() },
    timeout: 180_000,
  });
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

function completedText(events: StreamEvent[]) {
  const failure = events.find((event) => event.type === 'run.failed');
  expect(failure, failure?.error).toBeUndefined();
  const completed = [...events].reverse().find((event) => event.type === 'run.completed' && event.message?.content);
  return completed?.message?.content ?? events.filter((event) => event.type === 'content.delta').map((event) => event.delta ?? '').join('');
}

async function upload(api: ApiContext, conversationId: string, name: string, mimeType: string, buffer: Buffer) {
  const response = await api.post(`/api/conversations/${conversationId}/artifacts`, {
    multipart: { file: { name, mimeType, buffer } },
  });
  const body = await response.text();
  expect(response.status(), body).toBe(201);
  return (JSON.parse(body) as { artifact: { id: string } }).artifact.id;
}

test('Hermes registry, routing, participants, and fail-closed contracts', async ({}, testInfo) => {
  const api = await context();
  const conversations: string[] = [];
  try {
    const health = await api.get('/api/health');
    expect(health.status()).toBe(200);
    expect((await health.json()).ok).toBe(true);

    const response = await api.get('/api/agents?systemId=hermes');
    expect(response.status()).toBe(200);
    const agents = ((await response.json()) as { agents: Agent[] }).agents;
    expect(agents.map((agent) => agent.id)).toEqual(['[Hermes] Lucy', 'Xixi', 'Lynn', 'Gemma']);
    expect(new Set(agents.map((agent) => agent.id)).size).toBe(agents.length);
    expect(new Set(agents.map((agent) => agent.shortName.toLowerCase())).size).toBe(agents.length);
    expect(agents.filter((agent) => agent.isLead).map((agent) => agent.id)).toEqual(['[Hermes] Lucy']);
    for (const agent of agents) {
      expect(agent.systemId).toBe('hermes');
      expect(agent.enabled).toBe(true);
      expect(agent.directChatEnabled).toBe(true);
      expect(agent.displayName.length).toBeGreaterThan(0);
      expect(agent.shortName.length).toBeGreaterThan(0);
      expect(agent.role.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.capabilities.length).toBeGreaterThan(0);
    }

    const leadId = await createConversation(api, '[Hermes] Lucy', `HERMES_ROUTING_QA_${Date.now()}`);
    conversations.push(leadId);
    const participants = await api.get(`/api/conversations/${leadId}/participants`);
    expect(participants.status()).toBe(200);
    expect(((await participants.json()) as { participants: Array<{ agentId: string; role: string }> }).participants)
      .toEqual(expect.arrayContaining([expect.objectContaining({ agentId: '[Hermes] Lucy', role: 'lead' })]));

    const preview = await api.post(`/api/conversations/${leadId}/routing/preview`, {
      data: { content: '@Xixi implement, @Lynn review, and @Gemma inspect the image.' },
    });
    expect(preview.status()).toBe(200);
    expect(((await preview.json()) as { routing: unknown }).routing).toEqual(expect.objectContaining({
      mode: 'team',
      leadAgentId: '[Hermes] Lucy',
      mentionedAgentIds: ['Xixi', 'Lynn', 'Gemma'],
      targetAgentIds: ['Xixi', 'Lynn', 'Gemma', '[Hermes] Lucy'],
      rejectedMentions: [],
    }));

    for (const input of [
      { systemId: 'hermes', agentId: 'DOES_NOT_EXIST', title: 'invalid-agent-contract' },
      { systemId: 'letta', agentId: 'Xixi', title: 'system-mismatch-contract' },
    ]) {
      const rejected = await api.post('/api/conversations', { data: input });
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toEqual(expect.objectContaining({ error: 'AGENT_UNAVAILABLE' }));
    }

    await testInfo.attach('hermes-registry.json', {
      body: Buffer.from(JSON.stringify({ agents }, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    for (const id of conversations.reverse()) await removeConversation(api, id);
    await api.dispose();
  }
});

test('Hermes every enabled persona supports isolated direct chat', async ({}, testInfo) => {
  test.setTimeout(300_000);
  const api = await context();
  const conversations: string[] = [];
  const evidence: Array<{ agentId: string; conversationId: string; marker: string }> = [];
  try {
    const agentsResponse = await api.get('/api/agents?systemId=hermes');
    const agents = ((await agentsResponse.json()) as { agents: Agent[] }).agents.filter((agent) => agent.enabled && agent.directChatEnabled);
    expect(agents).toHaveLength(4);
    for (const [index, agent] of agents.entries()) {
      const marker = `HERMES_DIRECT_${index}_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const id = await createConversation(api, agent.id, `HERMES_DIRECT_QA_${agent.shortName}_${Date.now()}`);
      conversations.push(id);
      const events = await send(api, id, `Reply with ${marker} only.`);
      expect(completedText(events)).toContain(marker);
      const completed = events.find((event) => event.type === 'run.completed');
      expect(completed?.agentId ?? completed?.message?.authorId).toBe(agent.id);
      evidence.push({ agentId: agent.id, conversationId: id, marker });
    }
    expect(new Set(evidence.map((item) => item.conversationId)).size).toBe(evidence.length);
    await testInfo.attach('hermes-direct-chat.json', {
      body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json',
    });
  } finally {
    for (const id of conversations.reverse()) await removeConversation(api, id);
    await api.dispose();
  }
});

test('Hermes Gemma understands an image-only marker', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const api = await context();
  let conversationId = '';
  try {
    const marker = `HERMES_VISION_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await page.goto('/');
    const imageBase64 = await page.evaluate((text) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 300;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 52px sans-serif';
      ctx.fillText(text, 30, 170);
      return canvas.toDataURL('image/png').split(',')[1];
    }, marker);
    const visionAgentId = process.env.CHAT_HERMES_VISION_AGENT_ID?.trim() || 'Gemma';
    conversationId = await createConversation(api, visionAgentId, `HERMES_VISION_QA_${Date.now()}`);
    const artifactId = await upload(api, conversationId, 'hermes-vision.png', 'image/png', Buffer.from(imageBase64, 'base64'));
    const events = await send(
      api,
      conversationId,
      'Transcribe the large text in the attached synthetic QA image exactly. It is ordinary test text, not a password, credential, access token, CAPTCHA, verification code, or authentication challenge.',
      [artifactId],
    );
    expect(events.filter((event) => event.type === 'artifacts.delivery').map((event) => event.delivery?.state))
      .toEqual(['delivering', 'delivered']);
    expect(completedText(events)).toContain(marker);
    await testInfo.attach('hermes-vision.json', {
      body: Buffer.from(JSON.stringify({ agentId: visionAgentId, conversationId, artifactId, marker }, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    if (conversationId) await removeConversation(api, conversationId);
    await api.dispose();
  }
});
