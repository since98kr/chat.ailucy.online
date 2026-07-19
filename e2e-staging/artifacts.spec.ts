import { expect, request as apiRequest, test } from '@playwright/test';

const QA_TITLE_PREFIX = 'STAGING_BROWSER_ARTIFACT_QA_';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4GQAAAAASUVORK5CYII=',
  'base64',
);
const NOTE = Buffer.from('CHAT_V2_STAGING_ARTIFACT_BYTE_MATCH\n한글 실제 staging 검증\n', 'utf8');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>staging-download-only</text></svg>', 'utf8');

type ApiContext = Awaited<ReturnType<typeof apiRequest.newContext>>;

async function readDownload(download: import('@playwright/test').Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Download stream is unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function requireStatus(response: import('@playwright/test').Response, expected: number, operation: string) {
  if (response.status() === expected) return;
  const detail = await response.text().catch(() => '');
  throw new Error(`${operation} returned ${response.status()}: ${detail.slice(0, 500)}`);
}

async function deleteQaConversation(api: ApiContext, conversationId: string, alreadyTrashed = false) {
  if (!alreadyTrashed) {
    const trashed = await api.patch(`/api/conversations/${conversationId}`, { data: { status: 'trashed' } });
    if (!trashed.ok()) return false;
  }
  const deleted = await api.delete(`/api/conversations/${conversationId}`);
  return deleted.ok();
}

async function cleanStaleQaConversations(api: ApiContext) {
  for (const status of ['active', 'archived', 'trashed'] as const) {
    const response = await api.get(`/api/conversations?status=${status}`);
    if (!response.ok()) continue;
    const payload = await response.json() as { conversations?: Array<{ id?: string; title?: string }> };
    for (const conversation of payload.conversations ?? []) {
      if (!conversation.id || !conversation.title?.startsWith(QA_TITLE_PREFIX)) continue;
      await deleteQaConversation(api, conversation.id, status === 'trashed');
    }
  }
}

test('real staging supports chat links and durable artifact transport', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
  const email = process.env.CHAT_STAGING_EMAIL?.trim();
  if (!email) throw new Error('CHAT_STAGING_EMAIL is required');

  const api = await apiRequest.newContext({
    baseURL,
    extraHTTPHeaders: {
      'Cf-Access-Authenticated-User-Email': email,
      Origin: new URL(baseURL).origin,
    },
  });

  const marker = `${QA_TITLE_PREFIX}${Date.now()}`;
  let conversationId = '';

  try {
    await cleanStaleQaConversations(api);
    await page.goto('/');
    await expect(page.getByText('ailucy.online', { exact: true })).toBeVisible();

    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/conversations'),
    );
    await page.locator('.conversations-title button[aria-label="새 대화"]').click();
    const createResponse = await createResponsePromise;
    await requireStatus(createResponse, 201, 'create Conversation');
    const created = await createResponse.json() as { conversation?: { id?: string } };
    conversationId = created.conversation?.id ?? '';
    expect(conversationId).not.toBe('');

    await page.locator('input[type="file"]').setInputFiles([
      { name: 'staging-pixel.png', mimeType: 'image/png', buffer: PNG_1X1 },
      { name: 'staging-note.txt', mimeType: 'text/plain', buffer: NOTE },
      { name: 'staging-vector.svg', mimeType: 'image/svg+xml', buffer: SVG },
    ]);
    await expect(page.locator('.upload-chip--complete')).toHaveCount(3);

    await page.locator('.chat-column').evaluate((target) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['staging drag artifact'], 'staging-drag.txt', { type: 'text/plain' }));
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.locator('.upload-chip--complete').filter({ hasText: 'staging-drag.txt' })).toBeVisible();

    await page.locator('.composer textarea').evaluate((target) => {
      const bytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4GQAAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'staging-pasted.png', { type: 'image/png' }));
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(page.locator('.upload-chip--complete').filter({ hasText: 'staging-pasted.png' })).toBeVisible();
    await expect(page.getByText('첨부파일 5개가 다음 메시지에 포함됩니다.')).toBeVisible();

    const message = `${marker} UI transport QA. Respond only STAGING_BROWSER_OK. Link https://example.com/staging-qa.`;
    await page.locator('.composer textarea').fill(message);
    const streamResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().includes('/messages/stream'),
    );
    await page.locator('button[aria-label="전송"]').click();
    const streamResponse = await streamResponsePromise;
    await requireStatus(streamResponse, 200, 'stream message');
    await streamResponse.finished();

    const userMessage = page.locator('.message--user').filter({ hasText: marker }).last();
    await expect(userMessage).toBeVisible();
    const link = userMessage.getByRole('link', { name: 'https://example.com/staging-qa' });
    await expect(link).toHaveAttribute('href', 'https://example.com/staging-qa');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);

    const image = userMessage.locator('img[alt="staging-pixel.png"]');
    await expect(image).toBeVisible();
    expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const noteCard = userMessage.locator('.file-card').filter({ hasText: 'staging-note.txt' });
    await expect(noteCard).toContainText('text/plain');
    const noteDownloadPromise = page.waitForEvent('download');
    await noteCard.getByRole('link', { name: '파일 다운로드' }).click();
    expect(await readDownload(await noteDownloadPromise)).toEqual(NOTE);

    const svgCard = userMessage.locator('.file-card').filter({ hasText: 'staging-vector.svg' });
    await expect(svgCard).toContainText('application/octet-stream');
    await expect(userMessage.locator('img[alt="staging-vector.svg"]')).toHaveCount(0);
    const svgDownloadPromise = page.waitForEvent('download');
    await svgCard.getByRole('link', { name: '파일 다운로드' }).click();
    expect(await readDownload(await svgDownloadPromise)).toEqual(SVG);

    const retitled = await api.patch(`/api/conversations/${conversationId}`, { data: { title: marker } });
    expect(retitled.ok()).toBe(true);

    await page.reload();
    await page.locator('.conversation-row').filter({ hasText: marker }).first().click();
    const restored = page.locator('.message--user').filter({ hasText: marker }).last();
    await expect(restored.getByRole('link', { name: 'https://example.com/staging-qa' })).toBeVisible();
    await expect(restored.locator('img[alt="staging-pixel.png"]')).toBeVisible();
    await expect(restored.locator('.file-card').filter({ hasText: 'staging-note.txt' })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('real-staging-artifacts-and-links.png'), fullPage: false });
  } finally {
    if (conversationId) {
      const deleted = await deleteQaConversation(api, conversationId);
      if (!deleted) console.warn(`QA cleanup failed for Conversation ${conversationId}`);
    }
    await api.dispose();
  }
});