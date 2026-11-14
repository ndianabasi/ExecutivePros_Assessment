import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { ProviderClient } from '../../src/provider.js'
import { createPaymentReconciler } from '../../src/reconciliation.js'
import { useApiFixture } from '../macros.js'

async function makePendingPayment(db: Awaited<ReturnType<typeof useApiFixture>>['db'], expiresAt: Date) {
  const [cartIdRaw] = await db('carts').insert({ user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 250000 })
  const cartId = Number(cartIdRaw)
  await db('cart_items').insert({ cart_id: cartId, product_id: 1, product_name: 'Demo notebook', unit_price_minor: 250000, currency: 'NGN', quantity: 1, line_total_minor: 250000 })
  const reference = `pay_${Math.random().toString(36).slice(2, 18).padEnd(16, 'x')}`
  const [paymentIdRaw] = await db('payments').insert({ user_id: 1, cart_id: cartId, reference, status: 'pending',
    amount_minor: 250000, currency: 'NGN', checkout_expires_at: expiresAt.toISOString(), reconcile_after: new Date(0).toISOString() })
  const paymentId = Number(paymentIdRaw)
  await db('stock_reservations').insert({ payment_id: paymentId, product_id: 1, quantity: 1, status: 'active' })
  return { paymentId, reference }
}

test('reconciliation recovers a missed success webhook through the normal fulfilment transaction', async ({ assert }) => {
  const { db, config, providerLookups } = await useApiFixture()
  const now = new Date()
  const { paymentId, reference } = await makePendingPayment(db, new Date(now.getTime() + 86400000))
  providerLookups.status = 200
  providerLookups.payment = { amount: 250000, currency: 'NGN', status: 'success', provider_reference: 'provider-reconciled',
    checkout_expires_at: new Date(now.getTime() + 86400000).toISOString() }
  const provider = new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs)
  const reconciler = createPaymentReconciler(db, provider, config)

  await reconciler.runDue(now)

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'success')
  assert.equal(await db('fulfillments').where({ payment_id: paymentId }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal((await db('stock_reservations').where({ payment_id: paymentId }).first()).status, 'consumed')
  assert.equal(await db('provider_events').where({ reference, source: 'reconciliation', outcome: 'success' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
})

test('day-30 pending provider status fails the payment and releases stock without claiming cancellation', async ({ assert }) => {
  const { db, config, providerLookups } = await useApiFixture()
  const now = new Date()
  const { paymentId, reference } = await makePendingPayment(db, new Date(now.getTime() - 1))
  providerLookups.status = 200
  providerLookups.payment = { amount: 250000, currency: 'NGN', status: 'pending', checkout_expires_at: new Date(now.getTime() - 1).toISOString() }
  const reconciler = createPaymentReconciler(db,
    new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs), config)

  await reconciler.runDue(now)

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'failed')
  assert.equal((await db('stock_reservations').where({ payment_id: paymentId }).first()).status, 'released')
  assert.equal(await db('fulfillments').where({ payment_id: paymentId }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 0)
  assert.equal(await db('payment_incidents').where({ payment_id: paymentId, code: 'payment_expired_provider_pending' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal(await db('notification_outbox').where({ notification_type: 'payment_failed' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal((await db('provider_events').where({ reference, source: 'reconciliation', outcome: 'expired_provider_pending' }).first()) !== undefined, true)
})

test('provider outage at expiry leaves payment and reservation pending and alerts admins once', async ({ assert }) => {
  const { db, config, providerLookups } = await useApiFixture()
  const now = new Date()
  const { paymentId } = await makePendingPayment(db, new Date(now.getTime() - 1))
  providerLookups.status = 503
  const reconciler = createPaymentReconciler(db,
    new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs), config)

  await reconciler.runDue(now)
  await reconciler.runDue(new Date(now.getTime() + 10000))

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'pending')
  assert.equal((await db('stock_reservations').where({ payment_id: paymentId }).first()).status, 'active')
  assert.equal(await db('payment_incidents').where({ payment_id: paymentId, code: 'expired_payment_status_unavailable' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal(await db('notification_outbox').where({ notification_type: 'admin_incident' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
})

test('a webhook wins when it commits during an in-flight expiry status lookup', async ({ assert, client }) => {
  const { db, config, providerLookups } = await useApiFixture()
  const now = new Date()
  const { paymentId, reference } = await makePendingPayment(db, new Date(now.getTime() - 1))
  providerLookups.status = 200
  providerLookups.delayMs = 100
  providerLookups.payment = { amount: 250000, currency: 'NGN', status: 'pending', checkout_expires_at: new Date(now.getTime() - 1).toISOString() }
  const reconciler = createPaymentReconciler(db,
    new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs), config)
  const reconciliation = reconciler.runDue(now)
  for (let attempt = 0; attempt < 50 && !providerLookups.started; attempt += 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2))
  assert.isTrue(providerLookups.started)
  const event = { event_id: 'provider-expiry-race-0001', event_type: 'payment.success', status: 'success', reference,
    provider_reference: 'provider-won-race', amount: 250000, currency: 'NGN', occurred_at: now.toISOString() }
  const signature = `sha256=${createHmac('sha256', config.providerWebhookSecret).update(JSON.stringify(event)).digest('hex')}`
  const webhook = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', signature).json(event)
  assert.equal(webhook.body().data.outcome, 'processed')
  await reconciliation

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'success')
  assert.equal(await db('fulfillments').where({ payment_id: paymentId }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal(await db('payment_incidents').where({ payment_id: paymentId, code: 'payment_expired_provider_pending' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 0)
})
