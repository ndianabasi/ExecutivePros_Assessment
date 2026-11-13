import { test } from '@japa/runner'
import type { Knex } from 'knex'
import type { ApiConfig } from '../src/config.js'

export interface ApiTestFixture {
  db: Knex
  config: ApiConfig
  providerInitCalls: { count: number }
}

declare module '@japa/runner/core' {
  interface TestContext {
    apiFixture: ApiTestFixture
  }
}

export const useApiFixture = test.macro((japaTest) => japaTest.context.apiFixture)
