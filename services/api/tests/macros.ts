import { test } from '@japa/runner'
import type { Knex } from 'knex'
import type { ApiConfig } from '../src/config.js'

export interface ApiTestFixture {
  db: Knex
  config: ApiConfig
  providerInitCalls: { count: number }
  apiPort: number
  queue?: { requests: Array<{ authorization: string; requestId: string; body: Record<string, unknown> }>; responseStatus: number }
  dispatchOutbox?: () => Promise<void>
}

declare module '@japa/runner/core' {
  interface TestContext {
    apiFixture: ApiTestFixture
  }
}

export const useApiFixture = test.macro((japaTest) => japaTest.context.apiFixture)
