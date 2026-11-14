import { test } from '@japa/runner'
import { loadConfig } from '../../src/config.js'
import { ProviderHttpError } from '../../src/errors.js'
import { initializeValidator, validate } from '../../src/validation.js'

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PROVIDER_DB_PATH: '/tmp/provider-test.db',
    PORT: '43101',
    PROVIDER_PUBLIC_ORIGIN: 'http://127.0.0.1:43101',
    FRONTEND_ORIGIN: 'http://127.0.0.1:43100',
    API_WEBHOOK_URL: 'http://127.0.0.1:43100/v1/webhooks/payment',
    PROVIDER_SERVICE_SECRET: 'p'.repeat(32),
    PROVIDER_WEBHOOK_SECRET: 'w'.repeat(32),
    ...overrides,
  })
}

test('provider config validates fixed origins, webhook target, secrets, and timeout ordering', async ({
  assert,
}) => {
  assert.equal(config().port, 43101)
  assert.throws(() => config({ PROVIDER_PUBLIC_ORIGIN: 'http://127.0.0.1:43101/path' }))
  assert.throws(() => config({ API_WEBHOOK_URL: 'https://attacker.example/collect' }))
  assert.throws(() => config({ PROVIDER_SERVICE_SECRET: 'short' }))
  assert.throws(() => config({ WEBHOOK_HTTP_TIMEOUT_MS: '12000', WEBHOOK_JOB_TIMEOUT_MS: '10000' }))
  assert.throws(() => config({ NODE_ENV: 'production', PROVIDER_DB_PATH: '/tmp/provider.db' }))
  assert.throws(() => config({ NODE_ENV: 'production', PROVIDER_SERVICE_SECRET: 'p'.repeat(32) }))
})

test('VineJS initialization schemas reject invalid numbers, timestamps, and unrecognized fields', async ({
  assert,
}) => {
  const valid = {
    reference: 'pay_test_reference',
    amount: 100,
    currency: 'NGN',
    checkout_expires_at: new Date(Date.now() + 60000).toISOString(),
  }
  assert.equal((await validate<{ amount: number }>(initializeValidator, valid)).amount, 100)
  for (const value of [
    { ...valid, amount: 0 },
    { ...valid, amount: '100' },
    { ...valid, checkout_expires_at: 'tomorrow' },
    { ...valid, unknown: true },
  ]) {
    try {
      await validate(initializeValidator, value)
      assert.fail('Invalid initialization input unexpectedly passed')
    } catch (error) {
      assert.isTrue(error instanceof ProviderHttpError)
    }
  }
})
