import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: process.env.DOCS_TEST_URL ?? 'http://127.0.0.1:18081',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
  },
})
