import { createHash, createHmac, randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { useProviderFixture } from '../macros.js'

function input(scenario?: string) {
  const checkout_expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  return { reference: `pay_test_${randomUUID().replaceAll('-', '')}`, amount: 12500, currency: 'NGN', checkout_expires_at,
    ...(scenario ? { failure_scenario_code: scenario } : {}) }
}

function auth(secret: string) { return `Bearer ${secret}` }
async function waitFor(predicate: () => Promise<boolean>) {
  for (let index = 0; index < 150; index += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Provider fixture did not reach the expected state')
}
interface ApiClient {
  post(path: string): {
    header(name: string, value: string): {
      json(body: unknown): Promise<{ status(): number; body(): { data: { reference: string; payment_url: string; status: string } } }>
    }
  }
}
async function pay(client: ApiClient, fixture: Awaited<ReturnType<typeof useProviderFixture>>, scenario?: string) {
  const created = await client.post('/payments/initialise').header('Authorization', auth(fixture.config.serviceSecret)).json(input(scenario))
  return { response: created, data: created.body().data as { reference: string; payment_url: string; status: string } }
}
async function submit(fixture: Awaited<ReturnType<typeof useProviderFixture>>, paymentUrl: string, outcome = 'success') {
  const token = new URL(paymentUrl).pathname.split('/').at(-1)!
  return fetch(`http://127.0.0.1:${fixture.providerPort}/payments/submit`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ checkout_token: token, outcome }),
  })
}

test('service auth, scenarios, initialization replay, conflict, and status lookup follow the contract', async ({ assert, client }) => {
  const fixture = await useProviderFixture()
  assert.equal((await client.get('/health/ready')).status(), 200)
  const denied = await client.get('/failure-scenarios')
  assert.equal(denied.status(), 401)
  const catalogue = await client.get('/failure-scenarios').header('Authorization', auth(fixture.config.serviceSecret))
  assert.equal(catalogue.status(), 200)
  assert.equal(catalogue.body().data.length, 10)
  assert.equal(catalogue.body().data[0].code, 'PROVIDER_001')

  const request = input()
  const first = await client.post('/payments/initialise').header('Authorization', auth(fixture.config.serviceSecret)).json(request)
  const replay = await client.post('/payments/initialise').header('Authorization', auth(fixture.config.serviceSecret)).json(request)
  assert.equal(first.status(), 201)
  assert.equal(replay.status(), 200)
  assert.deepEqual(replay.body().data, first.body().data)
  const conflict = await client.post('/payments/initialise').header('Authorization', auth(fixture.config.serviceSecret)).json({ ...request, amount: 13000 })
  assert.equal(conflict.status(), 409)
  const status = await client.get(`/payments/${request.reference}`).header('Authorization', auth(fixture.config.serviceSecret))
  assert.equal(status.status(), 200)
  assert.equal(status.body().data.status, 'pending')
  const missing = await client.get('/payments/pay_missing_123456').header('Authorization', auth(fixture.config.serviceSecret))
  assert.equal(missing.status(), 404)
})

test('initialization delay is absent to lookup until one immutable payment is committed', async ({ assert }) => {
  const fixture = await useProviderFixture()
  const request = input('PROVIDER_001')
  const initPromise = fetch(`http://127.0.0.1:${fixture.providerPort}/payments/initialise`, {
    method: 'POST', headers: { authorization: auth(fixture.config.serviceSecret), 'content-type': 'application/json' }, body: JSON.stringify(request),
  })
  await new Promise((resolve) => setTimeout(resolve, 3))
  assert.isUndefined(await fixture.db('payments').where({ reference: request.reference }).first())
  const completed = await initPromise
  assert.equal(completed.status, 201)
  assert.equal(await fixture.db('payments').where({ reference: request.reference }).count({ count: '*' }).first().then((row) => Number(row?.count)), 1)
})

test('PROVIDER_002 fails before persistence and VineJS rejects unsafe initialization data', async ({ assert, client }) => {
  const fixture = await useProviderFixture()
  const failed = await client.post('/payments/initialise').header('Authorization', auth(fixture.config.serviceSecret)).json(input('PROVIDER_002'))
  const expired = await client.post('/payments/initialise').header('Authorization', auth(fixture.config.serviceSecret)).json({ ...input(), checkout_expires_at: new Date(Date.now() - 1000).toISOString() })
  const unknown = await client.post('/payments/initialise').header('Authorization', auth(fixture.config.serviceSecret)).json({ ...input(), extra: 'unexpected' })
  assert.equal(failed.status(), 500)
  assert.equal(expired.status(), 422)
  assert.equal(unknown.status(), 400)
  assert.equal(await fixture.db('payments').count({ count: '*' }).first().then((row) => Number(row?.count)), 0)
})

test('browser capability completes once, signs exact bytes, and exposes only a post-commit hint', async ({ assert, client }) => {
  const fixture = await useProviderFixture()
  const { data } = await pay(client, fixture)
  const token = new URL(data.payment_url).pathname.split('/').at(-1)!
  const page = await fetch(data.payment_url)
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.isTrue(html.includes('Pay successfully'))
  assert.isTrue(page.headers.get('cache-control')?.includes('no-store'))
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.isTrue(page.headers.get('content-security-policy')?.includes(`frame-ancestors http://127.0.0.1:${fixture.apiPort}`))
  const completed = await submit(fixture, data.payment_url)
  const completionHtml = await completed.text()
  assert.equal(completed.status, 200)
  assert.isTrue(completionHtml.includes('data-parent-message="true"'))
  const browserScript = await fetch(`http://127.0.0.1:${fixture.providerPort}/checkout.js`)
  assert.isTrue((await browserScript.text()).includes('mock-payment.finished'))
  await waitFor(async () => fixture.api.received.length === 1)
  const body = fixture.api.received[0]!.body
  const digest = createHmac('sha256', fixture.config.webhookSecret).update(body).digest('hex')
  assert.equal(fixture.api.received[0]!.signature, `sha256=${digest}`)
  assert.equal(JSON.parse(body.toString()).reference, data.reference)
  assert.isTrue(fixture.api.received[0]!.requestId.length > 10)
  const repeated = await submit(fixture, data.payment_url)
  assert.equal(repeated.status, 200)
  assert.equal(await fixture.db('webhook_events').count({ count: '*' }).first().then((row) => Number(row?.count)), 1)
  const payment = await fixture.db('payments').where({ reference: data.reference }).first()
  assert.equal(payment.status, 'success')
  assert.equal(payment.checkout_token_hash, createHash('sha256').update(token).digest('hex'))
})

test('scenario snapshots preserve skipped, duplicated, delayed, and conflicting event behavior', async ({ assert, client }) => {
  const fixture = await useProviderFixture()
  const skipped = await pay(client, fixture, 'WEBHOOK_004')
  await submit(fixture, skipped.data.payment_url)
  const skippedEvent = await fixture.db('webhook_events').where({ payment_id: (await fixture.db('payments').where({ reference: skipped.data.reference }).first()).id }).first()
  assert.equal(skippedEvent.status, 'skipped')

  const duplicate = await pay(client, fixture, 'WEBHOOK_001')
  await submit(fixture, duplicate.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 2)
  assert.equal(fixture.api.received[0]!.body.toString(), fixture.api.received[1]!.body.toString())
  assert.equal(await fixture.db('webhook_deliveries').where({ request_body_hash: createHash('sha256').update(fixture.api.received[0]!.body).digest('hex') }).count({ count: '*' }).first().then((row) => Number(row?.count)), 2)

  const sequential = await pay(client, fixture, 'WEBHOOK_002')
  await submit(fixture, sequential.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 5)
  assert.equal(fixture.api.received[2]!.body.toString(), fixture.api.received[4]!.body.toString())

  const delayed = await pay(client, fixture, 'WEBHOOK_003')
  await submit(fixture, delayed.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 6)

  const payOnly = await pay(client, fixture, 'WEBHOOK_008')
  const payPage = await fetch(payOnly.data.payment_url)
  const payHtml = await payPage.text()
  assert.isFalse(payHtml.includes('Fail payment'))
  await submit(fixture, payOnly.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 8)
  assert.equal(JSON.parse(fixture.api.received[6]!.body.toString()).status, 'success')
  assert.equal(JSON.parse(fixture.api.received[7]!.body.toString()).status, 'failed')
})

test('tampered-body and bad-signature scenarios preserve canonical outcome and transmitted evidence', async ({ assert, client }) => {
  const fixture = await useProviderFixture()
  fixture.api.responseStatus = 422
  const altered = await pay(client, fixture, 'WEBHOOK_011')
  await submit(fixture, altered.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 1)
  const alteredEvent = await fixture.db('webhook_events').where({ event_id: JSON.parse(fixture.api.received[0]!.body.toString()).event_id }).first()
  assert.notEqual(alteredEvent.canonical_body, alteredEvent.transmitted_body)
  assert.equal(JSON.parse(alteredEvent.canonical_body).amount + 1000, JSON.parse(alteredEvent.transmitted_body).amount)
  await waitFor(async () => (await fixture.db('webhook_events').where({ id: alteredEvent.id }).first())?.status === 'failed')
  assert.equal((await fixture.db('webhook_events').where({ id: alteredEvent.id }).first()).status, 'failed')

  fixture.api.responseStatus = 401
  const invalid = await pay(client, fixture, 'WEBHOOK_013')
  await submit(fixture, invalid.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 2)
  const body = fixture.api.received[1]!.body
  const correct = createHmac('sha256', fixture.config.webhookSecret).update(body).digest('hex')
  assert.notEqual(fixture.api.received[1]!.signature, `sha256=${correct}`)

  fixture.api.responseStatus = 400
  const malformed = await pay(client, fixture, 'WEBHOOK_016')
  await submit(fixture, malformed.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 3)
  assert.equal(fixture.api.received[2]!.body.toString(), '{"event_id":')
  const digest = createHmac('sha256', fixture.config.webhookSecret).update(fixture.api.received[2]!.body).digest('hex')
  assert.equal(fixture.api.received[2]!.signature, `sha256=${digest}`)
})

test('retryable webhook responses retry as Workmatic rounds while permanent rejection resolves the job', async ({ assert, client }) => {
  const fixture = await useProviderFixture()
  fixture.api.responseStatus = 503
  const retry = await pay(client, fixture)
  await submit(fixture, retry.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 1)
  fixture.api.responseStatus = 204
  await waitFor(async () => fixture.api.received.length === 2)
  const retryEvent = await fixture.db('webhook_events').where({ payment_id: (await fixture.db('payments').where({ reference: retry.data.reference }).first()).id }).first()
  assert.equal(retryEvent.status, 'delivered')
  assert.equal(await fixture.db('webhook_deliveries').where({ webhook_event_id: retryEvent.id }).count({ count: '*' }).first().then((row) => Number(row?.count)), 2)

  fixture.api.responseStatus = 422
  const rejected = await pay(client, fixture)
  await submit(fixture, rejected.data.payment_url)
  await waitFor(async () => fixture.api.received.length === 3)
  const rejectedPayment = await fixture.db('payments').where({ reference: rejected.data.reference }).first()
  const rejectedEvent = await fixture.db('webhook_events').where({ payment_id: rejectedPayment.id }).first()
  await waitFor(async () => (await fixture.db('webhook_events').where({ id: rejectedEvent.id }).first())?.status === 'failed')
  assert.equal((await fixture.db('webhook_events').where({ id: rejectedEvent.id }).first()).status, 'failed')
  const stats = await fixture.runtime.client.stats()
  assert.equal(stats.done, 2)
})
