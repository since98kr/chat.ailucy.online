import { test, expect } from '@playwright/test';

test('should send, edit and delete a message', async ({ page }) => {
  await page.goto('http://localhost:5173/chat/openclaw');

  // Send a message
  const input = page.locator('input[placeholder="Message..."]');
  await input.fill('Hello Playwright');
  await page.keyboard.press('Enter');

  // Verify message is sent
  const message = page.locator('text=Hello Playwright');
  await expect(message).toBeVisible();

  // Hover to reveal actions
  await message.hover();

  // Click edit
  await page.locator('button[title="Edit"]').last().click();

  // Edit message
  const textarea = page.locator('textarea');
  await textarea.fill('Hello edited');
  await page.click('text=Save');

  // Verify edited label and text
  await expect(page.locator('text=Hello edited')).toBeVisible();
  await expect(page.locator('text=(edited)')).toBeVisible();

  // Hover again to delete
  await page.locator('text=Hello edited').hover();
  await page.locator('button[title="Delete"]').last().click();

  // Verify message is gone
  await expect(page.locator('text=Hello edited')).not.toBeVisible();
});
