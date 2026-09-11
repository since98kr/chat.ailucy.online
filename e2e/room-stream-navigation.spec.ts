import { expect, test } from '@playwright/test';

async function createPersonalConversation(page: import('@playwright/test').Page) {
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations',
  );
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  const response = await createdResponse;
  return ((await response.json()).conversation as { id: string }).id;
}

async function latestAssistantState(page: import('@playwright/test').Page, conversationId: string) {
  const response = await page.request.get(`/api/conversations/${conversationId}`);
  const conversation = (await response.json()).conversation as {
    messages: Array<{ role: string; state: string; content: string }>;
  };
  return [...conversation.messages].reverse().find((message) => message.role === 'assistant') ?? null;
}

test('switching rooms keeps the source run alive and isolates a second room run', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');

  const roomA = await createPersonalConversation(page);
  const roomB = await createPersonalConversation(page);

  await page.locator(`[data-conversation-id="${roomA}"]`).click();
  await expect(page.locator(`[data-conversation-id="${roomA}"]`)).toHaveClass(/is-active/);

  const promptA = 'ROOM_A_BACKGROUND_RUN 서로 다른 방을 오가더라도 이 응답은 취소하지 말고 끝까지 완료해 주세요. 충분히 긴 응답 스트림을 유지하는 브라우저 회귀 검증입니다.';
  await page.locator('.composer textarea').fill(promptA);
  await page.getByRole('button', { name: '전송', exact: true }).click();
  await expect(page.locator('.run-status')).toBeVisible();

  // Navigation itself must only detach room A from the visible UI. The fetch
  // remains connected so the server-owned run can keep persisting deltas.
  await page.locator(`[data-conversation-id="${roomB}"]`).click();
  await expect(page.locator(`[data-conversation-id="${roomB}"]`)).toHaveClass(/is-active/);
  await expect(page.getByText(promptA, { exact: true })).toHaveCount(0);

  const promptB = 'ROOM_B_INDEPENDENT_RUN 이 방의 응답은 A 방의 실행 상태와 섞이지 않아야 합니다.';
  await page.locator('.composer textarea').fill(promptB);
  await page.getByRole('button', { name: '전송', exact: true }).click();
  await expect(page.getByText(promptB, { exact: true })).toBeVisible();

  await expect.poll(async () => (await latestAssistantState(page, roomA))?.state, { timeout: 10_000 })
    .toBe('complete');
  await expect.poll(async () => (await latestAssistantState(page, roomB))?.state, { timeout: 10_000 })
    .toBe('complete');

  const finalA = await latestAssistantState(page, roomA);
  const finalB = await latestAssistantState(page, roomB);
  expect(finalA?.content).toContain('ROOM_A_BACKGROUND_RUN');
  expect(finalB?.content).toContain('ROOM_B_INDEPENDENT_RUN');
  expect(finalA?.content).not.toContain('ROOM_B_INDEPENDENT_RUN');
  expect(finalB?.content).not.toContain('ROOM_A_BACKGROUND_RUN');

  await page.locator(`[data-conversation-id="${roomA}"]`).click();
  await expect(page.locator(`[data-conversation-id="${roomA}"]`)).toHaveClass(/is-active/);
  await expect(page.locator('.message--assistant').last()).toContainText('ROOM_A_BACKGROUND_RUN');
  await expect(page.getByText(promptB, { exact: true })).toHaveCount(0);
});

test('a slow stale room load never owns visible actions or overwrites newer system navigation', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');

  const roomA = await createPersonalConversation(page);
  const roomB = await createPersonalConversation(page);
  await page.locator(`[data-conversation-id="${roomA}"]`).click();
  await expect(page.locator(`[data-conversation-id="${roomA}"]`)).toHaveClass(/is-active/);

  let releaseRoomB!: () => void;
  let markRoomBRequested!: () => void;
  const roomBGate = new Promise<void>((resolve) => { releaseRoomB = resolve; });
  const roomBRequested = new Promise<void>((resolve) => { markRoomBRequested = resolve; });
  await page.route(`**/api/conversations/${roomB}`, async (route) => {
    markRoomBRequested();
    await roomBGate;
    await route.continue();
  });

  await page.locator(`[data-conversation-id="${roomB}"]`).click();
  await roomBRequested;

  // Until B's detail is actually available there is no visible Conversation
  // owner. The list may be replaced by the loading state, so assert ownership
  // directly rather than requiring stale Conversation rows to remain mounted.
  await expect(page.locator('.conversation-row.is-active')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '응답 중단' })).toHaveCount(0);

  // System cards remain navigable while a room detail is loading. A newer
  // Hermes navigation must invalidate the held B request, and B may never
  // overwrite the later visible system when its response finally arrives.
  await page.locator('.system-card--violet .system-card__header').click();
  await expect(page.locator('.system-card--violet')).toHaveClass(/is-selected/);
  await expect(page.locator('.chat-header')).toContainText('[Hermes] Lucy');

  releaseRoomB();
  await page.waitForTimeout(150);
  await expect(page.locator('.system-card--violet')).toHaveClass(/is-selected/);
  await expect(page.locator('.chat-header')).toContainText('[Hermes] Lucy');
});

test('reselecting the current status preserves the visible run owner and Stop action', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');

  const roomA = await createPersonalConversation(page);
  const prompt = 'SAME_STATUS_STOP_OWNER 현재 활성 탭을 다시 눌러도 이 방의 실행 소유권과 중단 버튼은 그대로 유지되어야 합니다.';
  await page.locator('.composer textarea').fill(prompt);
  await page.getByRole('button', { name: '전송', exact: true }).click();
  await expect(page.locator('.run-status')).toBeVisible();

  await page.locator('.sidebar-footer button').filter({ hasText: '활성' }).click();
  await expect(page.locator(`[data-conversation-id="${roomA}"]`)).toHaveClass(/is-active/);
  const stop = page.getByRole('button', { name: '응답 중단' });
  await expect(stop).toBeVisible();
  await stop.click();

  await expect.poll(async () => (await latestAssistantState(page, roomA))?.state, { timeout: 10_000 })
    .toBe('cancelled');
});
