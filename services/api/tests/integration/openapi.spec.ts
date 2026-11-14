import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('public OpenAPI document declares the configured server, auth boundaries, SSE, and no manual payment status route', async ({ assert, client }) => {
  const { config } = await useApiFixture()
  const response = await client.get('/v1/api_docs.json')
  assert.equal(response.status(), 200)
  assert.equal(response.body().openapi, '3.1.0')
  assert.deepEqual(response.body().servers, [{ url: config.apiPublicOrigin }])
  assert.exists(response.body().paths['/v1/events'].get)
  assert.exists(response.body().paths['/v1/webhooks/payment'].post.security[0].providerWebhookHmac)
  assert.exists(response.body().paths['/v1/payments/{payment_id}'].get.security[0].bearerAuth)
  assert.notExists(response.body().paths['/v1/payments/{payment_id}'].put)
  assert.notExists(response.body().paths['/v1/payments/{payment_id}'].patch)
  assert.include(response.body().info.description, 'demo-only')
})
