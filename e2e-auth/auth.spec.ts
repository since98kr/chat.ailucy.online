import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByText('Private AI workspace')).toBeVisible();
  const input = page.getByLabel('개인 액세스 토큰');
  await input.fill('wrong-value');
  await page.getByRole('button', { name: '안전하게 접속' }).click();
  await expect(page.getByText('액세스 토큰이 올바르지 않습니다.')).toBeVisible();
  await input.fill('e2e-only-value');
  await page.getByRole('button', { name: '안전하게 접속' }).click();
  await expect(page.getByText('ailucy.online', { exact: true })).toBeVisible();
}

test('token session protects the full browser workflow and operator status', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('desktop'));
  await login(page);

  await page.getByRole('button', { name: '시스템 설정' }).click();
  await expect(page.getByRole('complementary', { name: '시스템 상태' })).toBeVisible();
  await expect(page.getByText('private-session')).toBeVisible();
  await expect(page.getByText('[Letta] Lucy')).toBeVisible();
  await expect(page.getByText('[Hermes] Lucy')).toBeVisible();
  await page.getByRole('button', { name: '상태 패널 닫기' }).click();

  await page.locator('.conversation-menu summary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByText('Markdown 내보내기').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('.md');

  await page.getByRole('button', { name: '시스템 설정' }).click();
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByLabel('개인 액세스 토큰')).toBeVisible();
});

test('token login remains usable at the approved mobile frame', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'));
  await login(page);
  const metrics = await page.evaluate(() => ({ viewport: window.innerWidth, width: document.documentElement.scrollWidth }));
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport + 1);
  await expect(page.locator('.mobile-menu')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('token-mobile-390x844.png'), fullPage: false });
});
