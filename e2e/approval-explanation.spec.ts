import { expect, test } from '@playwright/test';

async function createPersonalConversation(page: import('@playwright/test').Page) {
  const mobileMenu = page.locator('.mobile-menu');
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar--open/);
  }
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations',
  );
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  const response = await createdResponse;
  return ((await response.json()).conversation as { id: string }).id;
}

test('pending approval keeps bounded backend metadata and controls reachable on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  const id = await createPersonalConversation(page);
  const initialContext = (await (await page.request.get(`/api/conversations/${id}/operating-context`)).json()).operatingContext;
  const longReason = `이유-${'가'.repeat(470)}`;
  const longVerification = `검증-${'나'.repeat(470)}`;
  const longRollback = `롤백-${'다'.repeat(470)}`;
  let streamWaiting = false;
  let releaseStream: (() => void) | undefined;
  let markStreamFulfilled: (() => void) | undefined;
  const streamFulfilled = new Promise<void>((resolve) => { markStreamFulfilled = resolve; });

  await page.route(`**/api/conversations/${id}/operating-context`, async (route) => {
    if (!streamWaiting) return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operatingContext: {
          ...initialContext,
          pendingApproval: {
            conversationId: id,
            backendSystem: initialContext.backendSystem,
            agentId: initialContext.agentId,
            sessionIdentity: initialContext.sessionIdentity,
            approvalId: `approval:${id}`,
            kind: 'exec',
            summary: '운영 서비스 재시작',
            reason: longReason,
            verificationPlan: longVerification,
            rollbackPlan: longRollback,
            state: 'pending',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      }),
    });
  });

  await page.route(`**/api/conversations/${id}/messages/stream`, async (route) => {
    const payload = route.request().postDataJSON() as { content?: string };
    if (payload.content !== '승인 설명 테스트') return route.continue();
    streamWaiting = true;
    await new Promise<void>((resolve) => { releaseStream = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '' });
    markStreamFulfilled?.();
  });

  const composer = page.locator('.composer textarea');
  await composer.fill('승인 설명 테스트');
  await page.locator('button[aria-label="전송"]').click();

  const approval = page.getByTestId('pending-approval');
  const approvalText = approval.locator('> span');
  await expect(approval).toContainText('운영 서비스 재시작');
  await expect(page.getByTestId('approval-reason')).toHaveText(`이유: ${longReason}`);
  await expect(page.getByTestId('approval-verification')).toHaveText(`검증: ${longVerification}`);
  await expect(page.getByTestId('approval-rollback')).toHaveText(`롤백: ${longRollback}`);
  await expect(approval.getByRole('button', { name: '승인' })).toBeInViewport();
  await expect(composer).toBeInViewport();

  const dimensions = await approvalText.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.clientHeight).toBeGreaterThan(0);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await page.getByTestId('approval-rollback').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('approval-rollback')).toBeVisible();
  await expect(approval.getByRole('button', { name: '승인' })).toBeInViewport();
  await expect(composer).toBeInViewport();

  releaseStream?.();
  await streamFulfilled;
  await expect(page.locator('button[aria-label="전송"]')).toBeEnabled();
});
