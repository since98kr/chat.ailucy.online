import { expect, request as apiRequest, test } from '@playwright/test';

const QA_TITLE_PREFIX = 'STAGING_LETTA_FULL_RUNTIME_';

type StreamEvent = {
  type: string;
  status?: string;
  delta?: string;
  error?: string;
};

function enabled(name: string) {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function authenticationHeaders() {
  const clientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) throw new Error('Both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required');
    return {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    };
  }
  const email = process.env.CHAT_STAGING_EMAIL?.trim();
  if (!email) throw new Error('CHAT_STAGING_EMAIL or Cloudflare Access service credentials are required');
  return { 'Cf-Access-Authenticated-User-Email': email };
}

function parseEvents(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

function responseText(events: StreamEvent[]) {
  return events.filter((event) => event.type === 'content.delta').map((event) => event.delta ?? '').join('');
}

function capabilityCounts(status: string) {
  const match = /^runtime\.capabilities:tools=(\d+);skill_sources=(\d+);mcp=(\d+);commands=(\d+);memfs=(true|false)$/.exec(status);
  if (!match) return null;
  return {
    tools: Number(match[1]),
    skillSources: Number(match[2]),
    mcp: Number(match[3]),
    commands: Number(match[4]),
    memfs: match[5] === 'true',
  };
}

test('real Letta Lucy reports its CLI model, advertises full capability, and executes a CLI tool', async () => {
  test.skip(!enabled('CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED'), 'Full Letta CLI runtime QA is not activated.');
  test.setTimeout(300_000);

  const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
  const api = await apiRequest.newContext({
    baseURL,
    extraHTTPHeaders: { ...authenticationHeaders(), Origin: new URL(baseURL).origin },
  });
  let conversationId = '';

  try {
    const created = await api.post('/api/conversations', {
      data: {
        systemId: 'letta',
        agentId: '[Letta] Lucy',
        title: `${QA_TITLE_PREFIX}${Date.now()}`,
      },
    });
    expect(created.status()).toBe(201);
    conversationId = (await created.json() as { conversation: { id: string } }).conversation.id;

    const streamed = await api.post(`/api/conversations/${conversationId}/messages/stream`, {
      data: {
        content: [
          'Before answering, use one harmless CLI tool to inspect the current working directory or list its top-level entries.',
          'Then answer in one sentence: state the exact runtime model identifier you are using and confirm that the tool completed.',
          'Do not guess the model and do not answer that you do not know.',
        ].join(' '),
        artifactIds: [],
      },
    });
    expect(streamed.status()).toBe(200);
    const events = parseEvents(await streamed.text());
    const statuses = events.filter((event) => event.type === 'run.status').map((event) => event.status ?? '');

    const modelStatus = statuses.find((status) => status.startsWith('runtime.model:'));
    expect(modelStatus).toBeTruthy();
    const model = modelStatus?.slice('runtime.model:'.length).trim() ?? '';
    expect(model.length).toBeGreaterThan(2);
    expect(model).not.toBe('null');

    const permissionStatus = statuses.find((status) => status.startsWith('runtime.permission:'));
    expect(permissionStatus).toBeTruthy();
    expect(permissionStatus).not.toBe('runtime.permission:unknown');

    const capabilityStatus = statuses.map(capabilityCounts).find(Boolean);
    expect(capabilityStatus).toBeTruthy();
    expect(capabilityStatus?.tools).toBeGreaterThan(0);
    expect(capabilityStatus?.skillSources).toBeGreaterThan(0);
    expect(capabilityStatus?.mcp).toBeGreaterThanOrEqual(0);
    expect(statuses).toContain('runtime.mcp_advertised:true');
    expect(capabilityStatus?.commands).toBeGreaterThan(0);
    expect(capabilityStatus?.memfs).toBe(true);
    expect(statuses.some((status) => status.startsWith('tool.running:') || status.startsWith('mcp.running:'))).toBe(true);
    expect(statuses.some((status) => status.startsWith('tool.completed:'))).toBe(true);

    const answer = responseText(events);
    expect(answer).toContain(model);
    expect(answer.toLowerCase()).not.toMatch(/do not know|don't know|모르|알 수 없/);
    expect(events.some((event) => event.type === 'run.completed')).toBe(true);
    expect(events.some((event) => event.type === 'run.failed')).toBe(false);
  } finally {
    if (conversationId) {
      await api.patch(`/api/conversations/${conversationId}`, { data: { status: 'trashed' } });
      await api.delete(`/api/conversations/${conversationId}`);
    }
    await api.dispose();
  }
});
