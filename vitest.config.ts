import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'e2e/**',
      'e2e-auth/**',
      'e2e-staging/**',
      'playwright-report/**',
      'playwright-auth-report/**',
      'playwright-staging-report/**',
      'playwright-external-staging-report/**',
      'test-results/**',
      'test-results-staging-browser/**',
      'test-results-external-staging-browser/**',
    ],
  },
});
