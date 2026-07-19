import { expect, test } from '@playwright/test';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4GQAAAAASUVORK5CYII=',
  'base64',
);
const NOTE = Buffer.from('CHAT_V2_ARTIFACT_BYTE_MATCH\n한글 파일 검증\n', 'utf8');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>download-only</text></svg>', 'utf8');

async function readDownload(download: import('@playwright/test').Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Download stream is unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('desktop attachments, links, downloads, and reload persistence work end to end', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));

  await page.goto('/');
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'qa-pixel.png', mimeType: 'image/png', buffer: PNG_1X1 },
    { name: 'qa-note.txt', mimeType: 'text/plain', buffer: NOTE },
    { name: 'qa-vector.svg', mimeType: 'image/svg+xml', buffer: SVG },
  ]);

  await expect(page.locator('.upload-chip--complete')).toHaveCount(3);
  const message = '첨부파일 검수 링크 https://example.com/qa.';
  await page.locator('.composer textarea').fill(message);
  await page.locator('button[aria-label="전송"]').click();

  const userMessage = page.locator('.message--user').filter({ hasText: '첨부파일 검수 링크' }).last();
  await expect(userMessage).toBeVisible();
  const link = userMessage.getByRole('link', { name: 'https://example.com/qa' });
  await expect(link).toHaveAttribute('href', 'https://example.com/qa');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);

  const image = userMessage.locator('img[alt="qa-pixel.png"]');
  await expect(image).toBeVisible();
  expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  const noteCard = userMessage.locator('.file-card').filter({ hasText: 'qa-note.txt' });
  await expect(noteCard).toContainText('text/plain');
  const noteDownloadPromise = page.waitForEvent('download');
  await noteCard.getByRole('link', { name: '파일 다운로드' }).click();
  expect(await readDownload(await noteDownloadPromise)).toEqual(NOTE);

  const svgCard = userMessage.locator('.file-card').filter({ hasText: 'qa-vector.svg' });
  await expect(svgCard).toContainText('application/octet-stream');
  await expect(userMessage.locator('img[alt="qa-vector.svg"]')).toHaveCount(0);
  const svgDownloadPromise = page.waitForEvent('download');
  await svgCard.getByRole('link', { name: '파일 다운로드' }).click();
  expect(await readDownload(await svgDownloadPromise)).toEqual(SVG);

  await page.reload();
  const restored = page.locator('.message--user').filter({ hasText: '첨부파일 검수 링크' }).last();
  await expect(restored.getByRole('link', { name: 'https://example.com/qa' })).toBeVisible();
  await expect(restored.locator('img[alt="qa-pixel.png"]')).toBeVisible();
  await expect(restored.locator('.file-card').filter({ hasText: 'qa-note.txt' })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('desktop-artifacts-and-links.png'), fullPage: false });
});

test('drag-and-drop and clipboard image paste create pending attachments', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));

  await page.goto('/');
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();

  await page.locator('.chat-column').evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['drag artifact'], 'drag-note.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('.upload-chip--complete').filter({ hasText: 'drag-note.txt' })).toBeVisible();

  await page.locator('.composer textarea').evaluate((target) => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4GQAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'pasted-pixel.png', { type: 'image/png' }));
    target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.locator('.upload-chip--complete').filter({ hasText: 'pasted-pixel.png' })).toBeVisible();
  await expect(page.getByText('첨부파일 2개가 다음 메시지에 포함됩니다.')).toBeVisible();
});
