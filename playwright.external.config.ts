import { defineConfig } from '@playwright/test';

const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'https://chat-staging.ailucy.online';
const clientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  throw new Error('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required for external staging QA');
}

export default defineConfig({
  testDir: './e2e-staging',
  outputDir: 'test-results-external-staging-browser',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-external-staging-report', open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    extraHTTPHeaders: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
