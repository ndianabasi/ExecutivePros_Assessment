import { test } from '@japa/runner'
import type { Knex } from 'knex'
import type { ProviderConfig } from '../src/config.js'

export interface ProviderTestFixture {
  db: Knex
  config: ProviderConfig
  api: { received: Array<{ body: Buffer; signature: string; paymentReference: string; referenceSignature: string; requestId: string }>; responseStatus: number }
  runtime: ReturnType<typeof import('../src/webhooks.js').createWebhookRuntime>
  providerPort: number
  apiPort: number
}

declare module '@japa/runner/core' {
  interface TestContext { providerFixture: ProviderTestFixture }
}

export const useProviderFixture = test.macro((japaTest) => japaTest.context.providerFixture)
