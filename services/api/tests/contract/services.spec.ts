import { test } from '@japa/runner'
import { EmailQueueClient } from '../../src/queue.js'
import { ProviderClient } from '../../src/provider.js'
import { useApiFixture } from '../macros.js'

test('provider status and queue job fixtures match the API outbound contracts', async ({ assert, client }) => {
  const { config, providerLookups, queue } = useApiFixture()
  const provider = new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs)
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const initialized = await provider.initialise({ reference: 'pay_contract_reference0001', amount: 12345, currency: 'NGN', checkout_expires_at: expiresAt })
  assert.equal(initialized.reference, 'pay_contract_reference0001')
  assert.equal(initialized.amount, 12345)
  providerLookups.status = 200
  providerLookups.payment = { amount: 12345, currency: 'NGN', status: 'success', checkout_expires_at: expiresAt }
  assert.equal((await provider.lookup(initialized.reference)).status, 'success')

  const queueClient = new EmailQueueClient(config.queueBaseUrl, config.queueServiceSecret, config.queueTimeoutMs)
  await queueClient.enqueue({ type: 'email', notification_key: 'contract-notification-1', to: 'user@example.test', subject: 'Contract', text: 'Contract test' }, 'contract-request-1')
  assert.equal(queue?.requests.at(-1)?.requestId, 'contract-request-1')
  assert.equal(queue?.requests.at(-1)?.body.notification_key, 'contract-notification-1')

  const openapi = await client.get('/v1/api_docs.json')
  assert.equal(openapi.status(), 200)
  assert.isTrue(Boolean(openapi.body().paths['/v1/cart/checkout'].post.parameters.some((parameter: { name: string }) => parameter.name === 'Idempotency-Key')))
  assert.equal(openapi.body().paths['/v1/webhooks/payment'].post.security[0].providerWebhookHmac.length, 0)
  assert.equal(openapi.body().components.schemas.PaymentWebhook.properties.status.enum.join(','), 'success,failed,cancelled')
  const userExample = openapi.body().paths['/v1/demo/users'].get.responses['200'].content['application/json'].examples.assessmentDemo.value
  const users = (await client.get('/v1/demo/users')).body().data
  for (const user of userExample.data) assert.deepEqual(users.find((actual: { id: number }) => actual.id === user.id), user)
  const productExample = openapi.body().paths['/v1/products'].get.responses['200'].content['application/json'].examples.assessmentDemo.value
  const productAuth = await client.post('/v1/login').json({ user_id: 1 })
  const products = await client.get('/v1/products').header('Authorization', `Bearer ${productAuth.body().data.token}`)
  assert.deepEqual(productExample, products.body())
  assert.deepEqual(openapi.body().paths['/v1/cart'].post.requestBody.content['application/json'].examples.assessmentDemo.value, { items: [{ product_id: 1, quantity: 1 }] })
})
