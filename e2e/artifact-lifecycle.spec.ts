import { expect, test } from '@playwright/test';

const NOTE = Buffer.from('ARTIFACT_LIFECYCLE_MARKER', 'utf8');

test('attachment delivery status remains understandable after reload', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.startsWith('mobile');
  const openMobileMenu = async () => {
    if (mobile) await page.getByRole('button', { name: '메뉴 열기' }).click();
  };

  await page.goto('/');
  await openMobileMenu();
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  if (mobile) await expect(page.locator('.drawer-scrim')).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'lifecycle-note.txt',
    mimeType: 'text/plain',
    buffer: NOTE,
  });
  await expect(page.locator('.upload-chip--complete')).toHaveCount(1);

  const prompt = '첨부파일 전달 상태 검증';
  await page.locator('.composer textarea').fill(prompt);
  await page.locator('button[aria-label="전송"]').click();

  const userMessage = page.locator('.message--user').filter({ hasText: prompt }).last();
  const lifecycle = userMessage.getByLabel('첨부 전달 상태');
  await expect(lifecycle).toContainText('백엔드 전달 완료');
  await expect(lifecycle).toContainText('이해 여부는 응답으로 확인');
  await expect(page.locator('.composer textarea')).toBeEnabled();

  await page.reload();
  await openMobileMenu();
  await page.locator('.conversation-row').filter({ hasText: prompt }).first().click();
  const restored = page.locator('.message--user').filter({ hasText: prompt }).last();
  await expect(restored.getByLabel('첨부 전달 상태')).toContainText('백엔드 전달 완료');
});
