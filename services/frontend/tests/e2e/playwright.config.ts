import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.FRONTEND_TEST_URL ?? 'http://127.0.0.1:18080',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
  },
  reporter: 'list',
})
