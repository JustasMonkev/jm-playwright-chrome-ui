import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: [
    'tests/**/*.spec.ts',
    'examples/**/*.spec.ts',
  ],
  outputDir: 'test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  timeout: 30_000,
  workers: 1,
  use: {
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
});
