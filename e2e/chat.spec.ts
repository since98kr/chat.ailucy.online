import { expect, test } from '@playwright/test';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

test('desktop Conversation workflow remains aligned and usable', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));

  await page.goto('/');
  await expect(page.getByText('ailucy.online', { exact: true })).toBeVisible();
  await expect(page.getByText('Chat V2 개발', { exact: true })).toBeVisible();
  await expect(page.getByText('[Hermes] Lucy', { exact: false }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  const composer = page.locator('textarea');
  await expect(composer).toBeEnabled();
  await composer.fill('브라우저 회귀검증 아젠다를 새 Conversation으로 유지해줘.');
  await page.locator('button[aria-label="전송"]').click();

  await expect(page.getByText('브라우저 회귀검증 아젠다를 새 Conversation으로 유지해줘.')).toBeVisible();
  await expect(page.getByText(/\[Hermes\] Lucy가 이 Conversation의 책임자로 응답합니다/)).toBeVisible();

  const search = page.getByPlaceholder('제목·본문·파일 검색');
  await search.fill('회귀검증');
  await expect(page.locator('.conversation-row').filter({ hasText: '회귀검증' }).first()).toBeVisible();
  await search.fill('');

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBe('/manifest.webmanifest');
  const serviceWorkerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? '';
  });
  expect(serviceWorkerUrl).toContain('/sw.js');

  await page.screenshot({ path: testInfo.outputPath('desktop-1280x900.png'), fullPage: false });
});

test('mobile navigation preserves the System → Conversation hierarchy', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'));

  await page.goto('/');
  await expect(page.locator('.mobile-menu')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.locator('.mobile-menu').click();
  await expect(page.locator('.sidebar')).toHaveClass(/sidebar--open/);
  await expect(page.getByText('SYSTEMS', { exact: true })).toBeVisible();
  await expect(page.getByText('CONVERSATIONS', { exact: true })).toBeVisible();

  await page.locator('.system-card--blue .system-card__header').click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar--open/);
  await expect(page.locator('.chat-header')).toContainText('[Letta] Lucy');
  await expect(page.locator('.chat-header')).toContainText('Personal');
  await expectNoHorizontalOverflow(page);

  await page.screenshot({ path: testInfo.outputPath('mobile-390x844.png'), fullPage: false });
});
