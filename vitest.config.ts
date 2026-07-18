import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'e2e/**',
      'e2e-auth/**',
      'playwright-report/**',
      'playwright-auth-report/**',
      'test-results/**',
    ],
  },
});
