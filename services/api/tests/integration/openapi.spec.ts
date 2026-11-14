import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('public OpenAPI document declares the configured server, auth boundaries, SSE, and no manual payment status route', async ({ assert, client }) => {
  const { config } = useApiFixture()
  const response = await client.get('/v1/api_docs.json')
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['cache-control'], 'no-store')
  assert.equal(response.body().openapi, '3.1.0')
  assert.deepEqual(response.body().servers, [{ url: config.apiPublicOrigin }])
  assert.exists(response.body().paths['/v1/api_docs.json'].get)
  assert.exists(response.body().paths['/v1/events'].get)
  assert.exists(response.body().paths['/v1/webhooks/payment'].post.security[0].providerWebhookHmac)
  assert.exists(response.body().paths['/v1/payments/{payment_id}'].get.security[0].bearerAuth)
  assert.notExists(response.body().paths['/v1/payments/{payment_id}'].put)
  assert.notExists(response.body().paths['/v1/payments/{payment_id}'].patch)
  assert.include(response.body().info.description, 'demo-only')

  const browserRequest = await client.get('/v1/demo/users').header('Origin', config.docsOrigin)
  assert.equal(browserRequest.headers()['access-control-allow-origin'], config.docsOrigin)
  const allowedHeaders = browserRequest.headers()['access-control-allow-headers'] ?? ''
  assert.include(allowedHeaders.toLowerCase(), 'authorization')
  assert.include(allowedHeaders.toLowerCase(), 'idempotency-key')
  const preflight = await client.options('/v1/cart/checkout')
    .header('Origin', config.docsOrigin)
    .header('Access-Control-Request-Method', 'POST')
    .header('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key')
  assert.equal(preflight.status(), 204)
  assert.equal(preflight.headers()['access-control-allow-origin'], config.docsOrigin)
  assert.include(preflight.headers()['access-control-allow-methods'], 'POST')
})
