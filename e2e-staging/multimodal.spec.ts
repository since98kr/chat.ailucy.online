import { expect, request as apiRequest, test } from '@playwright/test';

const QA_TITLE_PREFIX = 'STAGING_MULTIMODAL_QA_';

type ApiContext = Awaited<ReturnType<typeof apiRequest.newContext>>;
type StreamEvent = {
  type: string;
  delta?: string;
  artifact?: { id: string; filename: string; mimeType: string; sizeBytes: number };
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

async function deleteConversation(api: ApiContext, conversationId: string) {
  await api.patch(`/api/conversations/${conversationId}`, { data: { status: 'trashed' } });
  await api.delete(`/api/conversations/${conversationId}`);
}

async function createConversation(api: ApiContext, input: { systemId: 'letta' | 'hermes'; agentId: string; title: string }) {
  const response = await api.post('/api/conversations', { data: input });
  expect(response.status()).toBe(201);
  const payload = await response.json() as { conversation: { id: string } };
  return payload.conversation.id;
}

async function upload(api: ApiContext, conversationId: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  const response = await api.post(`/api/conversations/${conversationId}/artifacts`, {
    multipart: { file },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json() as { artifact: { id: string } };
  return payload.artifact.id;
}

async function send(api: ApiContext, conversationId: string, content: string, artifactIds: string[] = []) {
  const response = await api.post(`/api/conversations/${conversationId}/messages/stream`, {
    data: { content, artifactIds },
  });
  expect(response.status()).toBe(200);
  return (await response.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}

function responseText(events: StreamEvent[]) {
  return events.filter((event) => event.type === 'content.delta').map((event) => event.delta ?? '').join('');
}

test('real Letta and Hermes understand markers contained only in attachments', async ({ page }) => {
  test.skip(!enabled('CHAT_MULTIMODAL_QA_REQUIRED'), 'Real multimodal QA is not activated.');
  test.setTimeout(300_000);

  const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
  const api = await apiRequest.newContext({
    baseURL,
    extraHTTPHeaders: { ...authenticationHeaders(), Origin: new URL(baseURL).origin },
  });
  const conversations: string[] = [];

  try {
    const lettaMarker = `LETTA_DOC_${Date.now()}_7F92`;
    const lettaId = await createConversation(api, {
      systemId: 'letta',
      agentId: '[Letta] Lucy',
      title: `${QA_TITLE_PREFIX}LETTA_${Date.now()}`,
    });
    conversations.push(lettaId);
    const lettaArtifactId = await upload(api, lettaId, {
      name: 'letta-marker.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`The exact verification token is ${lettaMarker}.`, 'utf8'),
    });
    const lettaEvents = await send(
      api,
      lettaId,
      'Read the attached document. Return the exact verification token verbatim and no other token.',
      [lettaArtifactId],
    );
    expect(responseText(lettaEvents)).toContain(lettaMarker);

    await page.goto('/');
    const visionMarker = `VISION_${Date.now()}_7C11`;
    const imageBase64 = await page.evaluate((marker) => {
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 260;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000';
      context.font = 'bold 54px sans-serif';
      context.fillText(marker, 40, 145);
      return canvas.toDataURL('image/png').split(',')[1];
    }, visionMarker);

    const hermesId = await createConversation(api, {
      systemId: 'hermes',
      agentId: process.env.CHAT_HERMES_VISION_AGENT_ID?.trim() || 'Gemma',
      title: `${QA_TITLE_PREFIX}VISION_${Date.now()}`,
    });
    conversations.push(hermesId);
    const imageArtifactId = await upload(api, hermesId, {
      name: 'vision-marker.png',
      mimeType: 'image/png',
      buffer: Buffer.from(imageBase64, 'base64'),
    });
    const hermesEvents = await send(
      api,
      hermesId,
      'Read the text in the attached image. Return the exact verification token verbatim.',
      [imageArtifactId],
    );
    expect(responseText(hermesEvents)).toContain(visionMarker);
  } finally {
    for (const conversationId of conversations.reverse()) await deleteConversation(api, conversationId);
    await api.dispose();
  }
});

test('real Hermes returns a generated file that survives reload and byte verification', async ({ page }) => {
  test.skip(!enabled('CHAT_GENERATED_ARTIFACT_QA_REQUIRED'), 'Generated artifact QA is not activated.');
  test.setTimeout(300_000);

  const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
  const api = await apiRequest.newContext({
    baseURL,
    extraHTTPHeaders: { ...authenticationHeaders(), Origin: new URL(baseURL).origin },
  });
  let conversationId = '';

  try {
    const marker = `GENERATED_FILE_${Date.now()}_A91C`;
    const title = `${QA_TITLE_PREFIX}OUTPUT_${Date.now()}`;
    conversationId = await createConversation(api, {
      systemId: 'hermes',
      agentId: process.env.CHAT_HERMES_FILE_AGENT_ID?.trim() || '[Hermes] Lucy',
      title,
    });
    const events = await send(
      api,
      conversationId,
      `Use the return_artifact tool to create a UTF-8 text file named qa-result.txt. Its entire content must be exactly ${marker}`,
    );
    const created = events.find((event) => event.type === 'artifact.created')?.artifact;
    expect(created).toMatchObject({ filename: 'qa-result.txt', mimeType: 'text/plain' });

    const downloaded = await api.get(`/api/artifacts/${created?.id}/download`);
    expect(downloaded.status()).toBe(200);
    expect(Buffer.from(await downloaded.body()).toString('utf8')).toBe(marker);

    await page.goto('/');
    await page.locator('.conversation-row').filter({ hasText: title }).first().click();
    await expect(page.locator('.message--assistant .file-card').filter({ hasText: 'qa-result.txt' })).toBeVisible();
    await page.reload();
    await page.locator('.conversation-row').filter({ hasText: title }).first().click();
    await expect(page.locator('.message--assistant .file-card').filter({ hasText: 'qa-result.txt' })).toBeVisible();
  } finally {
    if (conversationId) await deleteConversation(api, conversationId);
    await api.dispose();
  }
});
