import { test } from '@japa/runner'
import type { Knex } from 'knex'
import type { ApiConfig } from '../src/config.js'
import type { PaymentEventHub } from '../src/payment-events.js'

export interface ApiTestFixture {
  db: Knex
  config: ApiConfig
  eventHub: PaymentEventHub
  providerInitCalls: { count: number }
  providerLookups: { status: number; payment?: Record<string, unknown>; delayMs: number; started: boolean }
  apiPort: number
  queue?: {
    requests: Array<{ authorization: string; requestId: string; body: Record<string, unknown> }>
    responseStatus: number
  }
  dispatchOutbox?: () => Promise<void>
}

declare module '@japa/runner/core' {
  interface TestContext {
    apiFixture: ApiTestFixture
  }
}

export const useApiFixture = test.macro((japaTest) => japaTest.context.apiFixture)
