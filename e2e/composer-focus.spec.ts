import { expect, test } from '@playwright/test';

async function createConversation(page: import('@playwright/test').Page) {
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations',
  );
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  await createdResponse;
}

async function expectComposerReadyAndFocused(page: import('@playwright/test').Page) {
  const composer = page.locator('.composer textarea');
  await expect(composer).toBeEnabled();
  await expect.poll(async () => page.evaluate(() => document.activeElement?.matches('.composer textarea') ?? false)).toBe(true);
}

test('OpenClaw Lucy restores composer focus after a completed response', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  await createConversation(page);

  const composer = page.locator('.composer textarea');
  await composer.fill('응답 뒤 입력창 포커스를 복원해줘.');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.locator('.message--assistant').last()).toHaveAttribute('class', /message--assistant/);
  await expectComposerReadyAndFocused(page);
});

test('Hermes Lucy restores composer focus after a completed response', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  await page.locator('.system-card--violet .system-card__header').click();
  await createConversation(page);

  const composer = page.locator('.composer textarea');
  await composer.fill('응답 뒤 입력창 포커스를 복원해줘.');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.locator('.message--assistant').last()).toHaveAttribute('class', /message--assistant/);
  await expectComposerReadyAndFocused(page);
});
