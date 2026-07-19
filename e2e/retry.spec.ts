import { expect, test } from '@playwright/test';

test('response regeneration preserves the source message and original response', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.startsWith('mobile');
  const openMobileMenu = async () => {
    if (mobile) await page.getByRole('button', { name: '메뉴 열기' }).click();
  };

  await page.goto('/');
  await openMobileMenu();
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();

  const source = 'V1_5_REGENERATION_MARKER';
  await page.locator('.composer textarea').fill(source);
  await page.locator('button[aria-label="전송"]').click();

  const userMessages = page.locator('.message--user').filter({ hasText: source });
  await expect(userMessages).toHaveCount(1);
  const original = page.locator('.message--assistant').last();
  await expect(original).toContainText(source);
  await expect(original.getByRole('button', { name: '응답 재생성' })).toBeVisible();

  await original.getByRole('button', { name: '응답 재생성' }).click();
  await expect(page.getByText('기존 응답을 보존하고 새 응답을 생성하는 중')).toBeVisible();
  await expect(page.locator('.message--assistant')).toHaveCount(2);
  const regenerated = page.locator('.message--assistant').last();
  await expect(regenerated).toContainText(source);
  await expect(regenerated.getByText('재생성 1')).toBeVisible();
  await expect(userMessages).toHaveCount(1);
  await expect(original).toBeVisible();
  await expect(page.getByText('기존 응답을 보존하고 새 응답을 생성하는 중')).toBeHidden();

  await page.reload();
  await openMobileMenu();
  await page.locator('.conversation-row').filter({ hasText: source }).first().click();
  await expect(page.locator('.message--user').filter({ hasText: source })).toHaveCount(1);
  await expect(page.locator('.message--assistant')).toHaveCount(2);
  await expect(page.locator('.message--assistant').last().getByText('재생성 1')).toBeVisible();
});
