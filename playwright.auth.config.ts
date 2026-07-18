import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-auth',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-auth-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4191',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command:
      "bash -lc 'rm -rf .e2e-auth-data && mkdir -p .e2e-auth-data/artifacts && CHAT_API_PORT=4191 CHAT_AUTH_MODE=token CHAT_ACCESS_TOKEN=e2e-only-value CHAT_DB_PATH=.e2e-auth-data/chat.sqlite CHAT_ARTIFACT_ROOT=.e2e-auth-data/artifacts CHAT_WEB_ROOT=dist node dist-server/runtime.js'",
    url: 'http://127.0.0.1:4191/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'token-desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'token-mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
