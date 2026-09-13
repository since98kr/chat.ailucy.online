import { expect, test } from '@playwright/test';

async function createPersonalConversation(page: import('@playwright/test').Page) {
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations',
  );
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  const response = await createdResponse;
  return ((await response.json()).conversation as { id: string }).id;
}

test('pending approval shows backend-owned reason, verification, rollback, and UNKNOWN for missing metadata', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  const id = await createPersonalConversation(page);
  const initialContext = (await (await page.request.get(`/api/conversations/${id}/operating-context`)).json()).operatingContext;
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
            reason: '새 설정을 적용하려면 재시작이 필요합니다.',
            verificationPlan: null,
            rollbackPlan: '기존 이미지로 되돌린 뒤 health를 확인합니다.',
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
  await expect(approval).toContainText('운영 서비스 재시작');
  await expect(page.getByTestId('approval-reason')).toHaveText('이유: 새 설정을 적용하려면 재시작이 필요합니다.');
  await expect(page.getByTestId('approval-verification')).toHaveText('검증: UNKNOWN');
  await expect(page.getByTestId('approval-rollback')).toHaveText('롤백: 기존 이미지로 되돌린 뒤 health를 확인합니다.');

  releaseStream?.();
  await streamFulfilled;
  await expect(page.locator('button[aria-label="전송"]')).toBeEnabled();
});
