import { test } from '@japa/runner'
import { useProviderFixture } from '../macros.js'

test('provider HTTP responses expose only the declared service contract and do not grant browser CORS', async ({
  assert,
  client,
}) => {
  const fixture = await useProviderFixture()
  const userToken = await client
    .post('/payments/initialise')
    .header('Authorization', `Bearer ${'u'.repeat(32)}`)
    .json({})
  assert.equal(userToken.status(), 401)

  const request = {
    reference: 'pay_contract_reference',
    amount: 1500,
    currency: 'NGN',
    checkout_expires_at: new Date(Date.now() + 60000).toISOString(),
  }
  const created = await client
    .post('/payments/initialise')
    .header('Authorization', `Bearer ${fixture.config.serviceSecret}`)
    .header('Origin', 'http://127.0.0.1:43100')
    .header('X-Request-ID', 'contract-request-1')
    .json(request)
  assert.equal(created.status(), 201)
  assert.equal(created.header('x-request-id'), 'contract-request-1')
  assert.isUndefined(created.header('access-control-allow-origin'))
  assert.equal(created.header('cache-control'), 'no-store')
  assert.deepEqual(Object.keys(created.body().data).sort(), [
    'amount',
    'checkout_expires_at',
    'currency',
    'payment_url',
    'provider_reference',
    'reference',
    'status',
  ])
  assert.equal(new URL(created.body().data.payment_url).origin, fixture.config.providerPublicOrigin)
})
