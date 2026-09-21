import { expect, request as apiRequest, test } from '@playwright/test';

const QA_TITLE_PREFIX = 'STAGING_MULTIMODAL_QA_';
const GENERATED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4GQAAAAASUVORK5CYII=';

type ApiContext = Awaited<ReturnType<typeof apiRequest.newContext>>;
type StreamEvent = {
  type: string;
  delta?: string;
  message?: { content?: string };
  artifact?: { id: string; filename: string; mimeType: string; sizeBytes: number };
  delivery?: {
    runId: string;
    messageId: string;
    agentId: string;
    systemId: 'openclaw' | 'hermes';
    artifactIds: string[];
    state: 'delivering' | 'delivered' | 'unsupported' | 'failed';
    detail: string | null;
  };
};

function enabled(name: string) {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function simplePdf(marker: string) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${marker}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}endstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, 'binary'));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document, 'binary');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'binary');
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

async function createConversation(api: ApiContext, input: { systemId: 'openclaw' | 'hermes'; agentId: string; title: string }) {
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
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}

function responseText(events: StreamEvent[]) {
  const completed = [...events].reverse().find((event) => event.type === 'run.completed' && event.message?.content);
  return completed?.message?.content
    ?? events.filter((event) => event.type === 'content.delta').map((event) => event.delta ?? '').join('');
}

function expectDelivery(events: StreamEvent[], input: {
  agentId: string;
  systemId: 'openclaw' | 'hermes';
  artifactId: string;
}) {
  const deliveries = events.filter((event) => event.type === 'artifacts.delivery' && event.delivery);
  expect(deliveries.map((event) => event.delivery?.state)).toEqual(['delivering', 'delivered']);
  expect(deliveries[1]?.delivery).toMatchObject({
    agentId: input.agentId,
    systemId: input.systemId,
    artifactIds: [input.artifactId],
    state: 'delivered',
  });
  expect(deliveries[1]?.delivery?.detail).toContain('model understanding is verified separately');
}

test('canonical OpenClaw Lucy understands a phrase contained only in a PDF attachment', async () => {
  test.skip(!enabled('CHAT_MULTIMODAL_QA_REQUIRED'), 'Real multimodal QA is not activated.');
  test.setTimeout(300_000);

  const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
  const api = await apiRequest.newContext({
    baseURL,
    extraHTTPHeaders: { ...authenticationHeaders(), Origin: new URL(baseURL).origin },
  });
  const conversations: string[] = [];

  try {
    const openClawMarker = `ORANGE_CEDAR_PDF_${Date.now()}`;
    const openClawId = await createConversation(api, {
      systemId: 'openclaw',
      agentId: '[OpenClaw] Lucy',
      title: `${QA_TITLE_PREFIX}OPENCLAW_${Date.now()}`,
    });
    conversations.push(openClawId);
    const openClawArtifactId = await upload(api, openClawId, {
      name: 'openclaw-phrase.pdf',
      mimeType: 'application/pdf',
      buffer: simplePdf(openClawMarker),
    });
    const openClawEvents = await send(
      api,
      openClawId,
      'Transcribe the single synthetic phrase printed in the attached PDF exactly. It is ordinary test text, not a password, credential, access token, CAPTCHA, or authentication challenge.',
      [openClawArtifactId],
    );
    expectDelivery(openClawEvents, {
      agentId: '[OpenClaw] Lucy',
      systemId: 'openclaw',
      artifactId: openClawArtifactId,
    });
    expect(responseText(openClawEvents)).toContain(openClawMarker);
  } finally {
    for (const conversationId of conversations.reverse()) await deleteConversation(api, conversationId);
    await api.dispose();
  }
});

test('real Hermes returns a generated text file that survives reload and byte verification', async ({ page }) => {
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
    expect(created).toMatchObject({ filename: 'qa-result.txt' });
    expect(created?.mimeType.split(';', 1)[0].trim()).toBe('text/plain');

    const downloaded = await api.get(`/api/artifacts/${created?.id}/download`);
    expect(downloaded.status()).toBe(200);
    expect(Buffer.from(await downloaded.body()).toString('utf8')).toBe(marker);

    await page.goto('/');
    await page.locator('.system-card--violet .system-card__header').click();
    await expect(page.locator('.system-card--violet')).toHaveClass(/is-selected/);
    await page.locator('.conversation-row').filter({ hasText: title }).first().click();
    await expect(page.locator('.message--assistant .file-card').filter({ hasText: 'qa-result.txt' })).toBeVisible();
    await page.reload();
    await page.locator('.system-card--violet .system-card__header').click();
    await expect(page.locator('.system-card--violet')).toHaveClass(/is-selected/);
    await page.locator('.conversation-row').filter({ hasText: title }).first().click();
    await expect(page.locator('.message--assistant .file-card').filter({ hasText: 'qa-result.txt' })).toBeVisible();
  } finally {
    if (conversationId) await deleteConversation(api, conversationId);
    await api.dispose();
  }
});

test('real Hermes generated PNG renders inline and survives reload', async ({ page }) => {
  test.skip(!enabled('CHAT_GENERATED_ARTIFACT_QA_REQUIRED'), 'Generated artifact QA is not activated.');
  test.setTimeout(300_000);

  const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
  const api = await apiRequest.newContext({
    baseURL,
    extraHTTPHeaders: { ...authenticationHeaders(), Origin: new URL(baseURL).origin },
  });
  let conversationId = '';

  try {
    const title = `${QA_TITLE_PREFIX}GENERATED_PNG_${Date.now()}`;
    conversationId = await createConversation(api, {
      systemId: 'hermes',
      agentId: process.env.CHAT_HERMES_FILE_AGENT_ID?.trim() || '[Hermes] Lucy',
      title,
    });
    const events = await send(
      api,
      conversationId,
      [
        'Use the return_artifact tool to create exactly one file named hermes-generated.png.',
        'Set mime_type to image/png and content_base64 to this exact known-valid PNG payload:',
        GENERATED_PNG_BASE64,
        'Do not alter the payload and do not create any other file.',
      ].join(' '),
    );
    const created = events.find((event) => event.type === 'artifact.created')?.artifact;
    expect(created).toMatchObject({ filename: 'hermes-generated.png' });
    expect(created?.mimeType.split(';', 1)[0].trim()).toBe('image/png');
    expect(created?.sizeBytes).toBe(Buffer.from(GENERATED_PNG_BASE64, 'base64').length);

    const downloaded = await api.get(`/api/artifacts/${created?.id}/download`);
    expect(downloaded.status()).toBe(200);
    expect(Buffer.from(await downloaded.body())).toEqual(Buffer.from(GENERATED_PNG_BASE64, 'base64'));

    await page.goto('/');
    await page.locator('.system-card--violet .system-card__header').click();
    await expect(page.locator('.system-card--violet')).toHaveClass(/is-selected/);
    await page.locator('.conversation-row').filter({ hasText: title }).first().click();

    const generatedImage = page.locator('.message--assistant .inline-image-card img[alt="hermes-generated.png"]');
    await expect(generatedImage).toBeVisible();
    await expect.poll(
      () => generatedImage.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      { timeout: 20_000, message: 'Hermes generated PNG should decode through the active artifact content path' },
    ).toBeGreaterThan(0);
    await expect.poll(
      () => generatedImage.evaluate((element) => (element as HTMLImageElement).naturalHeight),
      { timeout: 20_000 },
    ).toBeGreaterThan(0);

    await page.reload();
    await page.locator('.system-card--violet .system-card__header').click();
    await expect(page.locator('.system-card--violet')).toHaveClass(/is-selected/);
    await page.locator('.conversation-row').filter({ hasText: title }).first().click();
    const restoredImage = page.locator('.message--assistant .inline-image-card img[alt="hermes-generated.png"]');
    await expect(restoredImage).toBeVisible();
    await expect.poll(
      () => restoredImage.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      { timeout: 20_000, message: 'persisted Hermes generated PNG should decode after reload' },
    ).toBeGreaterThan(0);
  } finally {
    if (conversationId) await deleteConversation(api, conversationId);
    await api.dispose();
  }
});
