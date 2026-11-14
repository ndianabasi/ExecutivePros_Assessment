import assert from 'node:assert/strict'
import test from 'node:test'
import { checkoutStorageKey, isSpecialOperation, pathMatches, validateApiOrigin, validateOpenApi, type DemoIdentity } from '../../src/contracts.js'
import { specialOperationsPlugin } from '../../src/swagger-plugin.js'
import { createRequestInterceptor, createResponseInterceptor } from '../../src/request-guards.js'

function spec(origin = 'http://127.0.0.1:18083') {
  return {
    openapi: '3.1.0', info: { title: 'test', version: '1' }, servers: [{ url: origin }],
    paths: {
      '/v1/api_docs.json': { get: {} }, '/v1/demo/users': { get: {} }, '/v1/login': { post: {} },
      '/v1/logout': { post: {} }, '/v1/events': { get: {} }, '/v1/cart/checkout': { post: { parameters: [{ in: 'header', name: 'Idempotency-Key', required: true }] } },
      '/v1/webhooks/payment': { post: { security: [{ providerWebhookHmac: [] }] } },
      '/v1/payments/{payment_id}': { get: {} },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, providerWebhookHmac: { type: 'apiKey', in: 'header', name: 'X-Provider-Signature' } } },
  }
}

test('accepts browser origins and rejects paths, credentials and non-HTTP schemes', () => {
  assert.equal(validateApiOrigin('https://api.example.test:8443'), 'https://api.example.test:8443')
  for (const value of ['api:3000', 'ftp://api.example.test', 'https://user:secret@api.example.test', 'https://api.example.test/v1']) assert.throws(() => validateApiOrigin(value))
})

test('validates live API shape and matching effective server origins', () => {
  assert.equal(validateOpenApi(spec(), 'http://127.0.0.1:18083').openapi, spec().openapi)
  assert.throws(() => validateOpenApi(spec('https://untrusted.example'), 'http://127.0.0.1:18083'), /origin does not match/)
  const missingServers = spec() as ReturnType<typeof spec> & { paths: Record<string, { get?: Record<string, unknown> }> }
  delete (missingServers as unknown as { servers?: unknown }).servers
  assert.throws(() => validateOpenApi(missingServers, 'http://127.0.0.1:18083'), /no absolute server/)
})

test('rejects external references and client-controlled payment status paths', () => {
  const external = spec() as { paths: Record<string, unknown> }
  external.paths['/v1/test'] = { get: { schema: { $ref: 'https://example.test/schema.json' } } }
  assert.throws(() => validateOpenApi(external, 'http://127.0.0.1:18083'), /external reference/)
  const statusPath = spec() as { paths: Record<string, unknown> }
  statusPath.paths['/v1/payments/{payment_id}/status'] = { patch: {} }
  assert.throws(() => validateOpenApi(statusPath, 'http://127.0.0.1:18083'), /must not expose/)
})

test('recognizes special routes and safely matches parameterized paths', () => {
  assert.equal(isSpecialOperation('POST', '/v1/webhooks/payment'), true)
  assert.equal(isSpecialOperation('GET', '/v1/events'), true)
  assert.equal(isSpecialOperation('POST', '/v1/cart/checkout'), false)
  assert.equal(pathMatches('/v1/payments/{payment_id}', '/v1/payments/p_123'), true)
  assert.equal(pathMatches('/v1/payments/{payment_id}', '/v1/payments/a/b'), false)
  assert.equal(checkoutStorageKey(5), 'api-docs.checkout-key.v1:5')
})

test('Swagger plugin preserves special operations but sets Try it out to disabled', () => {
  const rendered: Array<{ component: unknown; props: Record<string, unknown> }> = []
  const plugin = specialOperationsPlugin({ React: { createElement: (component, props) => { rendered.push({ component, props }); return rendered.at(-1) } } })
  const original = () => 'operation'
  const wrap = plugin.wrapComponents.operation(original)
  const special = new Map<string, unknown>([['method', 'POST'], ['path', '/v1/webhooks/payment'], ['allowTryItOut', true]])
  const specialState = {
    get: (key: string) => String(special.get(key)),
    set: (key: string, value: unknown) => { const next = new Map(special); next.set(key, value); return { get: (name: string) => String(next.get(name)), set: () => { throw new Error('unexpected nested set') } } },
  }
  wrap({ operation: specialState })
  assert.equal(rendered.at(-1)?.component, original)
  const changed = rendered.at(-1)?.props.operation as { get: (key: string) => string }
  assert.equal(changed.get('allowTryItOut'), 'false')
  assert.equal(special.get('allowTryItOut'), true)
  assert.equal(plugin.components.authorizeBtn(), null)
  assert.equal(plugin.components.authorizeOperationBtn(), null)
})

test('request guard enforces origin, special routes, and selected-user-only Bearer injection', () => {
  const apiOrigin = 'http://127.0.0.1:18083'
  const document = spec() as ReturnType<typeof spec> & { paths: Record<string, Record<string, unknown>> }
  document.paths['/v1/payments/{payment_id}'].get = { security: [{ bearerAuth: [] }] }
  let identity: DemoIdentity | null = null
  const guard = createRequestInterceptor({ origin: apiOrigin, spec: () => document, identity: () => identity })
  assert.throws(() => guard({ url: `${apiOrigin}/v1/payments/1`, method: 'GET', headers: {} }), /Select a seeded user/)
  assert.throws(() => guard({ url: 'https://untrusted.example/v1/products', method: 'GET', headers: {} }), /outside the configured API origin/)
  assert.throws(() => guard({ url: `${apiOrigin}/v1/webhooks/payment`, method: 'POST', headers: {} }), /reserved/)
  identity = { token: 'selected-demo-token-0123456789', user: { user_id: 1, name: 'Demo User', role: 'user' } }
  const protectedRequest = guard({ url: `${apiOrigin}/v1/payments/1`, method: 'GET', headers: {} })
  assert.equal(protectedRequest.headers.Authorization, `Bearer ${identity.token}`)
  const publicRequest = guard({ url: `${apiOrigin}/v1/demo/users`, method: 'GET', headers: { Authorization: 'Bearer stale-override' } })
  assert.equal('Authorization' in publicRequest.headers, false)
})

test('401 clears protected identity but leaves public and network outcomes alone', () => {
  const document = spec() as ReturnType<typeof spec> & { paths: Record<string, Record<string, unknown>> }
  document.paths['/v1/payments/{payment_id}'].get = { security: [{ bearerAuth: [] }] }
  let cleared = 0
  const intercept = createResponseInterceptor({ spec: () => document, onUnauthorized: () => { cleared++ } })
  intercept({ status: 401, url: 'http://127.0.0.1:18083/v1/payments/1' })
  intercept({ status: 401, url: 'http://127.0.0.1:18083/v1/demo/users', method: 'GET' })
  intercept({ url: 'http://127.0.0.1:18083/v1/payments/1', method: 'GET' })
  assert.equal(cleared, 1)
})
