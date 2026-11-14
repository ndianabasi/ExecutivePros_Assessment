import { test } from '@japa/runner'
import type { QueueConfig } from '../src/config.js'
import type { createQueueRuntime } from '../src/jobs.js'

export interface QueueTestFixture {
  config: QueueConfig
  runtime: ReturnType<typeof createQueueRuntime>
  received: string[]
  behavior: { failuresRemaining: number; permanentReject: boolean }
}

declare module '@japa/runner/core' {
  interface TestContext {
    queueFixture: QueueTestFixture
  }
}

export const useQueueFixture = test.macro((japaTest) => japaTest.context.queueFixture)
