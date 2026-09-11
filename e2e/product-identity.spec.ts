import { expect, test } from '@playwright/test';

test('personal Lucy is OpenClaw and ChatGPT is shown only as an external connection capability', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');

  await expect(page.getByText('OpenClaw', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-header')).toContainText('[OpenClaw] Lucy');
  await expect(page.getByText('Letta', { exact: true })).toHaveCount(0);

  const chatGptCard = page.getByTestId('chatgpt-participant-card');
  await expect(chatGptCard).toBeVisible();
  await expect(chatGptCard).toContainText('ChatGPT');
  await expect(chatGptCard).toContainText('Available via ChatGPT connection');
  await expect(chatGptCard).toContainText('[ChatGPT] Lucy');
  await expect(chatGptCard).toContainText('Connect via ChatGPT');
  await expect(chatGptCard).not.toContainText('Connected room participant');

  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations',
  );
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const created = (await response.json()).conversation as { agentId: string; systemId: string };
  expect(created).toMatchObject({ systemId: 'letta', agentId: '[OpenClaw] Lucy' });
  await expect(page.locator('.chat-header')).toContainText('[OpenClaw] Lucy');
});
