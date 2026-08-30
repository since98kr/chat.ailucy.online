import { expect, test } from '@playwright/test';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const metrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

test('desktop Conversation workflow remains aligned and usable', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  await expect(page.getByText('ailucy.online', { exact: true })).toBeVisible();
  await expect(page.locator('.conversation-row').filter({ hasText: '이번 주 업무 정리' }).first()).toBeVisible();
  await expect(page.locator('.chat-header')).toContainText('[Letta] Lucy');
  await expectNoHorizontalOverflow(page);
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  const composer = page.locator('.composer textarea');
  await composer.fill('브라우저 회귀검증 아젠다를 새 Conversation으로 유지해줘.');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.getByText('브라우저 회귀검증 아젠다를 새 Conversation으로 유지해줘.')).toBeVisible();
  await expect(page.getByText(/\[Letta\] Lucy의 승인된 장기기억은 이어집니다/)).toBeVisible();
  const search = page.getByPlaceholder('제목·본문·파일 검색');
  await search.fill('회귀검증');
  await expect(page.locator('.conversation-row').filter({ hasText: '회귀검증' }).first()).toBeVisible();
  await search.fill('');
  expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe('/manifest.webmanifest');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? '')).toContain('/sw.js');
  await page.screenshot({ path: testInfo.outputPath('desktop-1280x900.png'), fullPage: false });
});

test('Hermes mentions preserve subagent originals and Lucy synthesis', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  await page.locator('.system-card--violet .system-card__header').click();
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  await page.getByRole('button', { name: '@Xixi', exact: true }).click();
  await page.getByRole('button', { name: '@Lynn', exact: true }).click();
  const composer = page.locator('.composer textarea');
  await composer.fill(`${await composer.inputValue()}구현안과 독립 검토를 함께 작성해줘.`);
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.getByText(/Xixi 원문 결과/)).toBeVisible();
  await expect(page.getByText(/Lynn 독립 검토 원문/)).toBeVisible();
  await expect(page.getByText(/\[Hermes\] Lucy 종합응답/)).toBeVisible();
  await expect(page.locator('.source-output')).toHaveCount(2);
  await page.getByRole('button', { name: /팀 3/ }).click();
  await expect(page.getByRole('complementary', { name: 'Hermes 팀 활동' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-hermes-team.png'), fullPage: false });
});

test('direct subagent entry opens an isolated agent Conversation', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  await page.locator('.system-card--violet .agent-row').filter({ hasText: 'Xixi' }).click();
  await expect(page.locator('.chat-header')).toContainText('Xixi');
  await expect(page.locator('.chat-header')).toContainText('Direct Agent');
  await page.locator('.composer textarea').fill('직접 구현 대화 경계를 확인해줘.');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.getByText(/Xixi 원문 결과/)).toBeVisible();
  await expect(page.getByText(/\[Hermes\] Lucy 종합응답/)).toHaveCount(0);
});

test('federated Conversation approves a capsule and records a parallel workflow', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  await page.locator('.conversations-title button[aria-label="새 교차 시스템 대화"]').click();
  const panel = page.getByRole('complementary', { name: '교차 시스템 워크플로' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('교차 시스템 활성')).toBeVisible();
  await panel.getByPlaceholder('Capsule 제목').fill('브라우저 승인 문맥');
  await panel.getByPlaceholder('상대 시스템에 전달할 승인 가능한 문맥').fill('테스트에 필요한 최소 문맥만 Letta에 전달한다.');
  await panel.getByRole('button', { name: 'Draft 생성' }).click();
  const capsule = panel.locator('.capsule-card').filter({ hasText: '브라우저 승인 문맥' });
  await capsule.getByRole('button', { name: '승인' }).click();
  await expect(capsule).toContainText('approved');
  await panel.getByRole('button', { name: '교차 시스템 패널 닫기' }).click();
  const targets = page.getByLabel('교차 시스템 대상 선택');
  await targets.getByRole('button', { name: '@Letta', exact: true }).click();
  await targets.getByRole('button', { name: '@Xixi', exact: true }).click();
  await page.locator('.composer textarea').fill('개인 우선순위와 구현안을 병렬로 검토하고 종합해줘.');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.getByText(/Xixi 원문 결과/)).toBeVisible();
  await expect(page.getByText(/승인된 장기기억/)).toBeVisible();
  await expect(page.getByText(/\[Hermes\] Lucy 종합응답/)).toBeVisible();
  await page.locator('.federation-button').click();
  await expect(panel.locator('.workflow-run-list')).toContainText('completed');
  await expect(panel.locator('.workflow-step')).toHaveCount(3);
  await expect(panel.locator('.workflow-events')).toContainText('run.completed');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-federated-workflow.png'), fullPage: false });
});

test('personal Lucy binds 계속해 to the same persisted task and fails closed on unbound 승인', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'));
  await page.goto('/');
  await page.locator('.conversations-title button[aria-label="새 대화"]').click();
  const composer = page.locator('.composer textarea');
  await composer.fill('첫 작업을 실제 대화 문맥으로 유지해줘.');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.getByText(/\[Letta\] Lucy의 승인된 장기기억은 이어집니다/)).toBeVisible();

  const conversationId = await page.evaluate(() => {
    const match = window.location.href.match(/conversations\/([^/?#]+)/);
    return match?.[1] ?? null;
  }).catch(() => null);
  const activeId = conversationId ?? await page.locator('.conversation-row.is-active, .conversation-row--active').first().getAttribute('data-conversation-id').catch(() => null);
  // The current UI does not encode the id in the URL on every layout, so use the
  // API list to select the newest personal conversation if needed.
  const list = await page.request.get('/api/conversations?systemId=letta&status=active');
  const conversations = (await list.json()).conversations as Array<{ id: string; title: string }>;
  const id = activeId ?? conversations.find((item) => item.title.includes('첫 작업'))?.id ?? conversations[0].id;
  const before = (await (await page.request.get(`/api/conversations/${id}/operating-context`)).json()).operatingContext;
  expect(before.activeTask.label).toContain('첫 작업');

  await composer.fill('계속해');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.getByText('계속해', { exact: true })).toBeVisible();
  const after = (await (await page.request.get(`/api/conversations/${id}/operating-context`)).json()).operatingContext;
  expect(after.activeTask).toEqual(before.activeTask);
  expect(after.continuationTarget).toEqual(before.continuationTarget);

  await composer.fill('승인');
  await page.locator('button[aria-label="전송"]').click();
  await expect(page.locator('.error-banner')).toContainText('검증된 승인 대기가 없습니다');
});

test('mobile navigation preserves the System → Conversation hierarchy', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'));
  await page.goto('/');
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

test('mobile Hermes team panel stays inside the approved frame', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'));
  await page.goto('/');
  await page.locator('.mobile-menu').click();
  await page.locator('.system-card--violet .system-card__header').click();
  await page.getByRole('button', { name: /팀 1/ }).click();
  await expect(page.getByRole('complementary', { name: 'Hermes 팀 활동' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-hermes-team-390x844.png'), fullPage: false });
});

test('mobile federated panel remains inside the approved frame', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'));
  await page.goto('/');
  await page.locator('.mobile-menu').click();
  await page.locator('.conversations-title button[aria-label="새 교차 시스템 대화"]').click();
  await expect(page.getByRole('complementary', { name: '교차 시스템 워크플로' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-federated-390x844.png'), fullPage: false });
});
