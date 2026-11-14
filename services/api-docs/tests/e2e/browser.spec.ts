import { expect, test } from '@playwright/test'

const apiOrigin = process.env.API_ORIGIN_TEST ?? 'http://127.0.0.1:18083'
const liveApiOrigin = process.env.LIVE_API_ORIGIN
const providerOrigin = process.env.PROVIDER_ORIGIN_TEST ?? 'http://127.0.0.1:18082'
const docsUrl = process.env.DOCS_TEST_URL ?? 'http://127.0.0.1:18081'
const demoToken = 'selected-demo-token-0123456789'

function liveSpec() {
  const secured = [{ bearerAuth: [] }]
  return {
    openapi: '3.1.0',
    info: { title: 'Browser fixture API', version: '1.0.0' },
    servers: [{ url: apiOrigin }],
    tags: [{ name: 'Auth' }, { name: 'Webhooks' }, { name: 'Events' }, { name: 'Products' }, { name: 'Payments' }],
    paths: {
      '/v1/api_docs.json': {
        get: { operationId: 'getOpenApiDocument', summary: 'Fetch OpenAPI', tags: ['Auth'], responses: { '200': { description: 'OpenAPI' } } },
      },
      '/v1/demo/users': {
        get: { operationId: 'listDemoUsers', summary: 'List demo users', tags: ['Auth'], responses: { '200': { description: 'Users' } } },
      },
      '/v1/login': {
        post: {
          operationId: 'login', summary: 'Login', tags: ['Auth'], security: [],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { user_id: { type: 'integer' } }, required: ['user_id'], example: { user_id: 1 } } } } },
          responses: { '200': { description: 'Login' } },
        },
      },
      '/v1/logout': {
        post: { operationId: 'logout', summary: 'Logout', tags: ['Auth'], security: secured, responses: { '204': { description: 'Logged out' } } },
      },
      '/v1/webhooks/payment': {
        post: { operationId: 'webhook', summary: 'Provider webhook', tags: ['Webhooks'], security: [{ providerWebhookHmac: [] }], responses: { '200': { description: 'Accepted' } } },
      },
      '/v1/events': {
        get: { operationId: 'events', summary: 'Payment events', tags: ['Events'], security: secured, responses: { '200': { description: 'Stream' } } },
      },
      '/v1/products': {
        get: { operationId: 'products', summary: 'List products', tags: ['Products'], security: secured, responses: { '200': { description: 'Products' } } },
      },
      '/v1/cart/checkout': {
        post: {
          operationId: 'checkout', summary: 'Checkout', tags: ['Payments'], security: secured,
          parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { cart_id: { type: 'integer' } } } } } },
          responses: { '201': { description: 'Created' } },
        },
      },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, providerWebhookHmac: { type: 'apiKey', in: 'header', name: 'X-Provider-Signature' } } },
  }
}

test('real browser enforces docs identity, special-operation and checkout-key rules', async ({ page, context }) => {
  const seen: Array<{ path: string; method: string; authorization?: string; idempotencyKey?: string; body?: string }> = []
  const outsideRequests: string[] = []
  let productsOutcome: 'success' | 'network' | 'unauthorized' = 'success'
  let logoutUnavailable = false
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(docsUrl).origin && url.origin !== apiOrigin) outsideRequests.push(request.url())
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await context.addInitScript(() => {
    if (sessionStorage.getItem('invalid-identity-seeded')) return
    localStorage.setItem('api-docs.identity.v1', JSON.stringify({ token: 'bad', user: 'invalid' }))
    sessionStorage.setItem('invalid-identity-seeded', '1')
  })
  await page.route(`${apiOrigin}/**`, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    seen.push({ path, method, authorization: request.headers().authorization, idempotencyKey: request.headers()['idempotency-key'], body: request.postData() ?? undefined })
    const cors = {
      'access-control-allow-origin': docsUrl,
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
    }
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' })
    if (path === '/v1/api_docs.json') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(liveSpec()) })
    if (path === '/v1/demo/users') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 1, first_name: 'Assessment', last_name: 'User', role: 'user' }, { id: 2, first_name: 'Assessment', last_name: 'Admin', role: 'admin' }] }) })
    if (path === '/v1/login') {
      const userId = Number(JSON.parse(request.postData() ?? '{}').user_id)
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ data: { token: userId === 2 ? 'admin-demo-token-0123456789' : demoToken, user: { id: userId, first_name: 'Assessment', last_name: userId === 2 ? 'Admin' : 'User', role: userId === 2 ? 'admin' : 'user' } } }) })
    }
    if (path === '/v1/logout') {
      if (logoutUnavailable) return route.abort('failed')
      return route.fulfill({ status: 204, headers: cors, body: '' })
    }
    if (path === '/v1/products') {
      if (productsOutcome === 'network') return route.abort('failed')
      if (productsOutcome === 'unauthorized') return route.fulfill({ status: 401, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'unauthorized', message: 'expired', request_id: 'test-request' } }) })
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 1, name: 'Demo notebook', price_minor: 250000, currency: 'NGN', available_stock: 20 }], meta: { page: 1, page_size: 20, total: 1 } }) })
    }
    if (path === '/v1/cart/checkout') return route.fulfill({ status: 201, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ data: { id: 1, reference: 'pay_browser_fixture', status: 'pending', payment_url: `${providerOrigin}/checkout/pay_browser_fixture` } }) })
    return route.fulfill({ status: 404, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'not_found', message: 'fixture route not found', request_id: 'test-request' } }) })
  })

  await page.goto('/')
  await expect(page.getByText('Live API specification loaded.')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('api-docs.identity.v1'))).toBeNull()
  for (const path of ['/v1/login', '/v1/logout', '/v1/webhooks/payment', '/v1/events']) {
    const special = page.locator('#swagger-ui .opblock').filter({ hasText: path })
    await expect(special).toBeVisible()
    await special.locator('.opblock-summary-control').click()
    await expect(special.getByRole('button', { name: 'Try it out' })).toHaveCount(0)
  }
  await expect(page.locator('.swagger-ui .auth-wrapper')).toBeHidden()
  await expect(page.locator('.swagger-ui .authorization__btn')).toBeHidden()

  await page.locator('#seeded-user').selectOption('1')
  await page.getByRole('button', { name: 'Select user' }).click()
  await expect(page.locator('#identity')).toContainText('Assessment User (user)')
  await page.getByRole('button', { name: 'Generate new key' }).click()
  const key = await page.locator('#checkout-key').inputValue()
  expect(key).toMatch(/^[0-9a-f-]{36}$/i)
  await page.getByRole('button', { name: 'Copy key' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key)

  const products = page.locator('#swagger-ui .opblock').filter({ hasText: '/v1/products' })
  await products.locator('.opblock-summary-control').click()
  await products.getByRole('button', { name: 'Try it out' }).click()
  await products.getByRole('button', { name: 'Execute' }).click()
  await expect.poll(() => seen.some(request => request.path === '/v1/products' && request.method === 'GET')).toBe(true)
  expect(seen.find(request => request.path === '/v1/products')?.authorization).toBe(`Bearer ${demoToken}`)
  const checkout = page.locator('#swagger-ui .opblock').filter({ hasText: '/v1/cart/checkout' })
  await checkout.locator('.opblock-summary-control').click()
  await checkout.getByRole('button', { name: 'Try it out' }).click()
  await checkout.getByRole('textbox', { name: 'Idempotency-Key' }).fill(key)
  await checkout.getByRole('button', { name: 'Execute' }).click()
  await expect.poll(() => seen.some(request => request.path === '/v1/cart/checkout')).toBe(true)
  expect(seen.find(request => request.path === '/v1/cart/checkout')?.idempotencyKey).toBe(key)
  await page.reload()
  await expect(page.locator('#identity')).toContainText('Assessment User (user)')
  await expect(page.locator('#checkout-key')).toHaveValue(key)
  logoutUnavailable = true
  await page.getByRole('button', { name: 'Switch user' }).click()
  await expect(page.locator('#identity')).toHaveText('No user selected')
  expect(await page.evaluate(() => Object.keys(localStorage).filter(keyName => keyName.startsWith('api-docs.')))).toEqual([])
  expect(seen.filter(request => request.path === '/v1/login')).toHaveLength(1)
  expect(seen.some(request => request.path === '/v1/logout' && request.authorization === `Bearer ${demoToken}`)).toBe(true)

  logoutUnavailable = false
  await page.locator('#seeded-user').selectOption('2')
  await page.getByRole('button', { name: 'Select user' }).click()
  await expect(page.locator('#identity')).toContainText('Assessment Admin (admin)')
  await page.getByRole('button', { name: 'Switch user' }).click()
  await expect(page.locator('#identity')).toHaveText('No user selected')
  expect(seen.filter(request => request.path === '/v1/login')).toHaveLength(2)
  expect(seen.some(request => request.path === '/v1/logout' && request.authorization === 'Bearer admin-demo-token-0123456789')).toBe(true)

  await page.locator('#seeded-user').selectOption('1')
  await page.getByRole('button', { name: 'Select user' }).click()
  const protectedProducts = page.locator('#swagger-ui .opblock').filter({ hasText: '/v1/products' })
  await protectedProducts.locator('.opblock-summary-control').click()
  await protectedProducts.getByRole('button', { name: 'Try it out' }).click()
  productsOutcome = 'network'
  await protectedProducts.getByRole('button', { name: 'Execute' }).click()
  await expect.poll(() => seen.filter(request => request.path === '/v1/products').length).toBeGreaterThan(1)
  await expect(page.locator('#identity')).toContainText('Assessment User (user)')
  productsOutcome = 'unauthorized'
  await protectedProducts.getByRole('button', { name: 'Execute' }).click()
  await expect(page.locator('#identity')).toHaveText('No user selected')
  await expect(page.getByRole('alert')).toContainText('expired')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)
  await page.goto('/?url=https%3A%2F%2Fattacker.example%2Fopenapi.json')
  await expect(page.locator('#status')).toHaveText('Live API specification loaded.')
  expect(outsideRequests).toEqual([])
  expect(await page.locator('body').innerText()).not.toContain(demoToken)
  expect(await page.locator('body').innerText()).not.toContain('admin-demo-token-0123456789')
})

test('container HTTP headers and live configuration are verified in browser context', async ({ request }) => {
  const configResponse = await request.get('/config.json')
  expect(configResponse.status()).toBe(200)
  expect(configResponse.headers()['cache-control']).toBe('no-store')
  expect(configResponse.headers()['content-security-policy']).toContain(`connect-src 'self' ${apiOrigin}`)
  expect(await configResponse.json()).toEqual({ API_ORIGIN: apiOrigin })
  const html = await request.get('/')
  expect(html.headers()['cache-control']).toBe('no-store')
  expect(html.headers()['content-security-policy']).toContain("script-src 'self'")
})

test('seeded-user discovery shows an actionable error and populates the picker on retry', async ({ page }) => {
  let unavailable = true
  await page.route(`${apiOrigin}/v1/demo/users`, async route => {
    if (unavailable) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [
      { id: 1, first_name: 'Assessment', last_name: 'User', role: 'user' },
      { id: 2, first_name: 'Assessment', last_name: 'Admin', role: 'admin' },
    ] }) })
  })
  await page.goto(docsUrl)
  await expect(page.locator('.toolbar .control-card')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: 'Choose an API identity' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Prepare checkout' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'API reference' })).toBeVisible()
  await expect(page.locator('#status')).toHaveText('Live API specification loaded.')
  await expect(page.locator('#user-state')).toContainText('Retry user discovery')
  await expect(page.locator('#seeded-user')).toBeDisabled()
  unavailable = false
  await page.getByRole('button', { name: 'Retry user discovery' }).click()
  await expect(page.locator('#user-state')).toContainText('2 seeded users are available.')
  await expect(page.locator('#seeded-user option')).toHaveCount(3)
  await expect(page.locator('#seeded-user')).toBeEnabled()
  await page.locator('#seeded-user').selectOption('1')
  await expect(page.getByRole('button', { name: 'Select user' })).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('deployed Swagger Try it out calls the configured live API directly', async ({ page }) => {
  test.skip(!liveApiOrigin, 'Set LIVE_API_ORIGIN to enable the isolated Compose contract smoke')
  await page.goto(docsUrl)
  await expect(page.getByText('Live API specification loaded.')).toBeVisible()
  await page.locator('#seeded-user').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Select user' }).click()
  await expect(page.locator('#identity')).toContainText('(user)')

  const products = page.locator('#swagger-ui .opblock').filter({ hasText: '/v1/products' })
  await products.locator('.opblock-summary-control').click()
  await products.getByRole('button', { name: 'Try it out' }).click()
  await products.getByRole('button', { name: 'Execute' }).click()
  await expect(products.locator('.responses-wrapper')).toContainText('200')
  await expect(products.locator('.responses-wrapper')).toContainText('DEMO-NOTEBOOK')
})

test('spec errors, origin mismatch and API outage keep operations disabled until a fresh valid retry', async ({ page }) => {
  let mode: 'offline' | 'bad-json' | 'wrong-origin' | 'external-ref' | 'cors-denied' | 'valid' = 'offline'
  await page.route(`${apiOrigin}/**`, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const cors = { 'access-control-allow-origin': docsUrl, 'content-type': 'application/json', 'cache-control': 'no-store' }
    if (url.pathname === '/v1/demo/users') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ data: [] }) })
    if (url.pathname !== '/v1/api_docs.json') return route.fulfill({ status: 404, headers: cors, body: '{}' })
    if (mode === 'offline') return route.abort('failed')
    if (mode === 'bad-json') return route.fulfill({ status: 200, headers: cors, body: '{' })
    if (mode === 'cors-denied') return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(liveSpec()) })
    if (mode === 'wrong-origin') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ ...liveSpec(), servers: [{ url: 'https://wrong.example.test' }] }) })
    if (mode === 'external-ref') {
      const invalid = liveSpec()
      ;(invalid.paths['/v1/products'].get.responses['200'] as { schema: { $ref: string } }).schema = { $ref: 'https://wrong.example.test/schema.json' }
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(invalid) })
    }
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(liveSpec()) })
  })

  await page.goto('/')
  await expect(page.locator('#status')).toContainText('Specification unavailable')
  await expect(page.locator('#swagger-ui .opblock')).toHaveCount(0)
  mode = 'bad-json'
  await page.getByRole('button', { name: 'Refresh specification' }).click()
  await expect(page.locator('#status')).toContainText('JSON')
  await expect(page.locator('#swagger-ui .opblock')).toHaveCount(0)
  mode = 'wrong-origin'
  await page.getByRole('button', { name: 'Refresh specification' }).click()
  await expect(page.locator('#status')).toContainText('origin does not match')
  await expect(page.locator('#swagger-ui .opblock')).toHaveCount(0)
  mode = 'external-ref'
  await page.getByRole('button', { name: 'Refresh specification' }).click()
  await expect(page.locator('#status')).toContainText('external reference')
  mode = 'cors-denied'
  await page.getByRole('button', { name: 'Refresh specification' }).click()
  await expect(page.locator('#status')).toContainText('Specification unavailable')
  await expect(page.locator('#swagger-ui .opblock')).toHaveCount(0)
  mode = 'valid'
  await page.getByRole('button', { name: 'Refresh specification' }).click()
  await expect(page.locator('#status')).toHaveText('Live API specification loaded.')
  await expect(page.locator('#swagger-ui .opblock')).not.toHaveCount(0)
  mode = 'offline'
  await page.getByRole('button', { name: 'Refresh specification' }).click()
  await expect(page.locator('#status')).toContainText('Specification unavailable')
  await expect(page.locator('#swagger-ui .opblock')).toHaveCount(0)
  expect((await page.request.get('/health/ready')).status()).toBe(200)
  mode = 'valid'
  await page.getByRole('button', { name: 'Refresh specification' }).click()
  await expect(page.locator('#status')).toHaveText('Live API specification loaded.')
})
