import { createHash, createHmac } from 'node:crypto'
import { test } from '@japa/runner'
import { ProviderClient } from '../../src/provider.js'
import { createPaymentReconciler } from '../../src/reconciliation.js'
import { useApiFixture } from '../macros.js'

async function readActivities(reader: ReadableStreamDefaultReader<Uint8Array>, expected: number) {
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<Record<string, unknown>> = []
  while (events.length < expected) {
    const packet = await reader.read()
    if (packet.done) break
    buffer += decoder.decode(packet.value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      if (!frame.includes('event: payment-activity')) continue
      const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
      if (data) events.push(JSON.parse(data) as Record<string, unknown>)
    }
  }
  return events
}

async function createPayment(db: Awaited<ReturnType<typeof useApiFixture>>['db'], reference: string) {
  const cartId = Number((await db('carts').insert({ user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 250000 }))[0])
  await db('cart_items').insert({ cart_id: cartId, product_id: 1, product_name: 'Demo notebook', unit_price_minor: 250000, currency: 'NGN', quantity: 1, line_total_minor: 250000 })
  const [paymentId] = await db('payments').insert({ user_id: 1, cart_id: cartId, reference, status: 'pending', amount_minor: 250000, currency: 'NGN', checkout_expires_at: new Date(Date.now() + 86400000).toISOString() })
  await db('stock_reservations').insert({ payment_id: paymentId, product_id: 1, quantity: 1, status: 'active' })
  return Number(paymentId)
}

test('payment activity SSE records webhook receipt, verification, result and terminal status for the owner only', async ({ assert, client }) => {
  const { db, config, apiPort } = useApiFixture()
  const ownerLogin = await client.post('/v1/login').json({ user_id: 1 })
  const otherLogin = await client.post('/v1/login').json({ user_id: 3 })
  const ownerToken = ownerLogin.body().data.token as string
  const otherToken = otherLogin.body().data.token as string
  const unauthorized = await fetch(`http://127.0.0.1:${apiPort}/v1/events`)
  assert.equal(unauthorized.status, 401)

  const reference = 'pay_sse_owner_scope_00000001'
  const paymentId = await createPayment(db, reference)

  const ownerResponse = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${ownerToken}` } })
  const otherResponse = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${otherToken}` } })
  assert.equal(ownerResponse.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(ownerResponse.headers.get('cache-control'), 'no-cache, no-store, must-revalidate')
  const ownerReader = ownerResponse.body!.getReader()
  const otherReader = otherResponse.body!.getReader()
  await ownerReader.read()
  await otherReader.read()
  const event = { event_id: 'provider-sse-owner-event-0001', event_type: 'payment.success', status: 'success', reference,
    provider_reference: 'provider-sse-owner-0001', amount: 250000, currency: 'NGN', occurred_at: new Date().toISOString() }
  const signature = `sha256=${createHmac('sha256', config.providerWebhookSecret).update(JSON.stringify(event)).digest('hex')}`
  const accepted = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', signature).json(event)
  assert.equal(accepted.status(), 200)

  const activities = await readActivities(ownerReader, 4)
  assert.deepEqual(activities.map((activity) => activity.type), [
    'webhook_received', 'webhook_verification_succeeded', 'payment_succeeded', 'webhook_result',
  ])
  for (const activity of activities) {
    assert.equal(activity.payment_id, paymentId)
    assert.equal(activity.reference, reference)
    assert.isTrue(Number.isFinite(Date.parse(String(activity.occurred_at))))
    assert.isTrue(typeof activity.id === 'string' && typeof activity.title === 'string' && typeof activity.message === 'string')
  }
  assert.equal(activities[2]?.status, 'success')

  const otherNext = otherReader.read()
  const otherPacket = await Promise.race([otherNext.then((value) => value), new Promise<null>((resolveWait) => setTimeout(() => resolveWait(null), 75))])
  assert.isNull(otherPacket)
  await ownerReader.cancel()
  await otherReader.cancel()
})

test('invalid webhook signature is emitted as an owner-scoped verification incident', async ({ assert }) => {
  const { db, apiPort } = useApiFixture()
  const login = await fetch(`http://127.0.0.1:${apiPort}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1 }) })
  const { data } = await login.json() as { data: { token: string } }
  const reference = 'pay_sse_invalid_signature_00001'
  await createPayment(db, reference)
  const stream = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${data.token}` } })
  const reader = stream.body!.getReader()
  await reader.read()
  const body = { event_id: 'invalid-sse-event-0001', event_type: 'payment.success', status: 'success', reference, amount: 250000, currency: 'NGN', occurred_at: new Date().toISOString() }
  const rejected = await fetch(`http://127.0.0.1:${apiPort}/v1/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-provider-signature': `sha256=${'0'.repeat(64)}` }, body: JSON.stringify(body) })
  assert.equal(rejected.status, 401)
  const activities = await readActivities(reader, 2)
  assert.deepEqual(activities.map((activity) => activity.type), ['webhook_received', 'webhook_verification_failed'])
  assert.equal(activities[1]?.payment_id, await db('payments').where({ reference }).first().then((payment) => Number(payment.id)))
  assert.include(String(activities[1]?.message), 'No payment data was applied')
  await reader.cancel()
})

test('malformed signed webhook emits owner-scoped receipt, verification, and rejection activities', async ({ assert }) => {
  const { db, config, apiPort } = useApiFixture()
  const login = await fetch(`http://127.0.0.1:${apiPort}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1 }) })
  const { data } = await login.json() as { data: { token: string } }
  const reference = 'pay_sse_malformed_webhook_0001'
  const paymentId = await createPayment(db, reference)
  const stream = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${data.token}` } })
  const reader = stream.body!.getReader()
  await reader.read()
  const body = '{"event_id":'
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const signature = createHmac('sha256', config.providerWebhookSecret).update(body).digest('hex')
  const referenceSignature = createHmac('sha256', config.providerWebhookSecret).update(`${reference}\n${bodyHash}`).digest('hex')
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/webhooks/payment`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-provider-signature': `sha256=${signature}`,
      'x-provider-payment-reference': reference, 'x-provider-reference-signature': `sha256=${referenceSignature}` } })

  assert.equal(response.status, 400)
  const activities = await readActivities(reader, 3)
  assert.deepEqual(activities.map((activity) => activity.type), ['webhook_received', 'webhook_verification_succeeded', 'webhook_result'])
  assert.equal(activities[0]?.payment_id, paymentId)
  assert.equal(activities[2]?.payment_id, paymentId)
  assert.equal(activities[2]?.title, 'Malformed Webhook Rejected')
  assert.equal(await db('payment_incidents').where({ payment_id: paymentId, code: 'malformed_webhook_json' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'pending')
  await reader.cancel()
})

test('checkout SSE describes payment acceptance and provider initialization', async ({ assert, client }) => {
  const { apiPort } = useApiFixture()
  const login = await client.post('/v1/login').json({ user_id: 1 })
  const token = login.body().data.token as string
  const stream = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${token}` } })
  const reader = stream.body!.getReader()
  await reader.read()
  const cart = await client.post('/v1/cart').header('Authorization', `Bearer ${token}`).json({ items: [{ product_id: 1, quantity: 1 }] })
  const checkout = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'sse-checkout-key-0001').json({})
  assert.equal(checkout.status(), 201)
  const activities = await readActivities(reader, 3)
  assert.deepEqual(activities.map((activity) => activity.type), [
    'payment_pending', 'provider_initialization_started', 'provider_initialization_succeeded',
  ])
  assert.equal(activities[0]?.payment_id, checkout.body().data.id)
  assert.equal(activities[0]?.reference, checkout.body().data.reference)
  assert.equal(cart.status(), 200)
  await reader.cancel()
})

test('reconciliation emits started, applied status, and completed activity records', async ({ assert }) => {
  const { db, config, apiPort, eventHub, providerLookups } = useApiFixture()
  const login = await fetch(`http://127.0.0.1:${apiPort}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 1 }) })
  const { data } = await login.json() as { data: { token: string } }
  const reference = 'pay_sse_reconciliation_0000001'
  const paymentId = await createPayment(db, reference)
  const now = new Date()
  await db('payments').where({ id: paymentId }).update({ reconcile_after: new Date(now.getTime() - 1000).toISOString() })
  providerLookups.status = 200
  providerLookups.payment = { amount: 250000, currency: 'NGN', status: 'success', provider_reference: 'provider_reconciled_1', checkout_expires_at: new Date(now.getTime() + 86400000).toISOString() }
  const stream = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${data.token}` } })
  const reader = stream.body!.getReader()
  await reader.read()
  const reconciler = createPaymentReconciler(db, new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs), config, eventHub)
  await reconciler.runDue(now)
  const activities = await readActivities(reader, 3)
  assert.deepEqual(activities.map((activity) => activity.type), ['reconciliation_started', 'payment_succeeded', 'reconciliation_completed'])
  assert.equal(activities[0]?.attempt_number, 1)
  assert.equal(activities[1]?.status, 'success')
  assert.equal(activities[2]?.status, 'success')
  assert.equal(activities[2]?.payment_id, paymentId)
  await reader.cancel()
  await reconciler.close()
})
