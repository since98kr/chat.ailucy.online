import { defineConfig } from '@playwright/test';

const baseURL = process.env.CHAT_STAGING_BASE_URL?.trim() || 'http://127.0.0.1:14174';
const email = process.env.CHAT_STAGING_EMAIL?.trim();
const origin = process.env.CHAT_STAGING_ORIGIN?.trim() || 'https://chat-staging.ailucy.online';

export default defineConfig({
  testDir: './e2e-staging',
  outputDir: 'test-results-staging-browser',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-staging-report', open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    extraHTTPHeaders: {
      ...(email ? { 'Cf-Access-Authenticated-User-Email': email } : {}),
      Origin: origin,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});