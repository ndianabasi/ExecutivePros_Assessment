import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { ProviderClient } from '../../src/provider.js'
import { createPaymentReconciler } from '../../src/reconciliation.js'
import { useApiFixture } from '../macros.js'

async function makePendingPayment(db: Awaited<ReturnType<typeof useApiFixture>>['db'], expiresAt: Date) {
  const [cartIdRaw] = await db('carts').insert({
    user_id: 1,
    status: 'checked_out',
    currency: 'NGN',
    total_minor: 250000,
  })
  const cartId = Number(cartIdRaw)
  await db('cart_items').insert({
    cart_id: cartId,
    product_id: 1,
    product_name: 'Demo notebook',
    unit_price_minor: 250000,
    currency: 'NGN',
    quantity: 1,
    line_total_minor: 250000,
  })
  const reference = `pay_${Math.random().toString(36).slice(2, 18).padEnd(16, 'x')}`
  const [paymentIdRaw] = await db('payments').insert({
    user_id: 1,
    cart_id: cartId,
    reference,
    status: 'pending',
    amount_minor: 250000,
    currency: 'NGN',
    checkout_expires_at: expiresAt.toISOString(),
    reconcile_after: new Date(0).toISOString(),
  })
  const paymentId = Number(paymentIdRaw)
  await db('stock_reservations').insert({
    payment_id: paymentId,
    product_id: 1,
    quantity: 1,
    status: 'active',
  })
  return { paymentId, reference }
}

test('reconciliation records each lookup and resolves a webhook mismatch through the normal fulfilment transaction', async ({
  assert,
  client,
}) => {
  const { db, config, providerLookups } = useApiFixture()
  const now = new Date()
  const { paymentId, reference } = await makePendingPayment(db, new Date(now.getTime() + 86400000))
  const mismatch = {
    event_id: 'provider-mismatch-before-reconcile',
    event_type: 'payment.success',
    status: 'success',
    reference,
    provider_reference: 'provider-mismatched',
    amount: 250001,
    currency: 'NGN',
    occurred_at: now.toISOString(),
  }
  const mismatchSignature = `sha256=${createHmac('sha256', config.providerWebhookSecret).update(JSON.stringify(mismatch)).digest('hex')}`
  const rejectedEvidence = await client
    .post('/v1/webhooks/payment')
    .header('X-Provider-Signature', mismatchSignature)
    .json(mismatch)
  assert.equal(rejectedEvidence.status(), 422)
  assert.equal(rejectedEvidence.body().error.code, 'payment_evidence_mismatch')

  providerLookups.status = 200
  providerLookups.payment = {
    amount: 250000,
    currency: 'NGN',
    status: 'success',
    provider_reference: 'provider-reconciled',
    checkout_expires_at: new Date(now.getTime() + 86400000).toISOString(),
  }
  const provider = new ProviderClient(
    config.providerBaseUrl,
    config.providerServiceSecret,
    config.providerTimeoutMs,
  )
  const reconciler = createPaymentReconciler(db, provider, config)

  await reconciler.runDue(now)

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'success')
  assert.equal(
    await db('fulfillments')
      .where({ payment_id: paymentId })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    1,
  )
  assert.equal((await db('stock_reservations').where({ payment_id: paymentId }).first()).status, 'consumed')
  assert.equal(
    await db('provider_events')
      .where({ reference, source: 'reconciliation', outcome: 'success' })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    1,
  )
  const attempt = await db('payment_reconciliation_attempts').where({ payment_id: paymentId }).first()
  assert.equal(attempt.attempt_number, 1)
  assert.equal(attempt.outcome, 'provider_success_reconciled')
  assert.equal(attempt.provider_status, 'success')
  assert.equal(attempt.started_at, now.toISOString())
  assert.isNotNull(attempt.completed_at)
  assert.include(attempt.redacted_details, 'verified and applied')

  const login = await client.post('/v1/login').json({ user_id: 1 })
  const detail = await client
    .get(`/v1/payments/${paymentId}`)
    .header('Authorization', `Bearer ${login.body().data.token}`)
  assert.equal(detail.status(), 200)
  assert.equal(detail.body().data.incidents.length, 1)
  assert.equal(detail.body().data.incidents[0].code, 'provider_amount_currency_mismatch')
  assert.isNotNull(detail.body().data.incidents[0].created_at)
  assert.equal(detail.body().data.reconciliation_attempts.length, 1)
  assert.equal(detail.body().data.reconciliation_attempts[0].outcome, 'provider_success_reconciled')
  assert.isNotNull(detail.body().data.reconciliation_attempts[0].completed_at)
})

test('invalid webhook signature incident stays attached to payment after provider reconciliation', async ({
  assert,
  client,
}) => {
  const { db, config, providerLookups } = useApiFixture()
  const now = new Date()
  const { paymentId, reference } = await makePendingPayment(db, new Date(now.getTime() + 86400000))
  const event = {
    event_id: 'provider-invalid-signature-reconcile',
    event_type: 'payment.success',
    status: 'success',
    reference,
    provider_reference: 'provider-webhook-013',
    amount: 250000,
    currency: 'NGN',
    occurred_at: now.toISOString(),
  }
  const invalidSignature = `sha256=${'0'.repeat(64)}`
  const rejected = await client
    .post('/v1/webhooks/payment')
    .header('X-Provider-Signature', invalidSignature)
    .json(event)
  assert.equal(rejected.status(), 401)
  const incident = await db('payment_incidents')
    .where({ payment_id: paymentId, code: 'invalid_webhook_signature' })
    .first()
  assert.isDefined(incident)
  assert.equal(incident.reference, reference)
  assert.include(incident.redacted_details, 'unverified contents were not applied')
  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'pending')

  providerLookups.status = 200
  providerLookups.payment = {
    amount: 250000,
    currency: 'NGN',
    status: 'success',
    provider_reference: 'provider-webhook-013',
    checkout_expires_at: new Date(now.getTime() + 86400000).toISOString(),
  }
  const provider = new ProviderClient(
    config.providerBaseUrl,
    config.providerServiceSecret,
    config.providerTimeoutMs,
  )
  const reconciler = createPaymentReconciler(db, provider, config)
  await reconciler.runDue(now)

  const login = await client.post('/v1/login').json({ user_id: 1 })
  const detail = await client
    .get(`/v1/payments/${paymentId}`)
    .header('Authorization', `Bearer ${login.body().data.token}`)
  assert.equal(detail.status(), 200)
  assert.equal(detail.body().data.status, 'success')
  assert.equal(detail.body().data.incidents.length, 1)
  assert.equal(detail.body().data.incidents[0].code, 'invalid_webhook_signature')
  assert.equal(detail.body().data.reconciliation_attempts[0].outcome, 'provider_success_reconciled')
})

test('day-30 pending provider status fails the payment and releases stock without claiming cancellation', async ({
  assert,
}) => {
  const { db, config, providerLookups } = useApiFixture()
  const now = new Date()
  const { paymentId, reference } = await makePendingPayment(db, new Date(now.getTime() - 1))
  providerLookups.status = 200
  providerLookups.payment = {
    amount: 250000,
    currency: 'NGN',
    status: 'pending',
    checkout_expires_at: new Date(now.getTime() - 1).toISOString(),
  }
  const reconciler = createPaymentReconciler(
    db,
    new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs),
    config,
  )

  await reconciler.runDue(now)

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'failed')
  const attempt = await db('payment_reconciliation_attempts').where({ payment_id: paymentId }).first()
  assert.equal(attempt.outcome, 'provider_pending_expired')
  assert.equal(attempt.provider_status, 'pending')
  assert.isNotNull(attempt.started_at)
  assert.isNotNull(attempt.completed_at)
  assert.include(attempt.redacted_details, 'reserved stock released')
  assert.equal((await db('stock_reservations').where({ payment_id: paymentId }).first()).status, 'released')
  assert.equal(
    await db('fulfillments')
      .where({ payment_id: paymentId })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    0,
  )
  assert.equal(
    await db('payment_incidents')
      .where({ payment_id: paymentId, code: 'payment_expired_provider_pending' })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    1,
  )
  assert.equal(
    await db('notification_outbox')
      .where({ notification_type: 'payment_failed' })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    1,
  )
  assert.equal(
    (await db('provider_events')
      .where({ reference, source: 'reconciliation', outcome: 'expired_provider_pending' })
      .first()) !== undefined,
    true,
  )
})

test('provider outage at expiry leaves payment and reservation pending and alerts admins once', async ({
  assert,
}) => {
  const { db, config, providerLookups } = useApiFixture()
  const now = new Date()
  const { paymentId } = await makePendingPayment(db, new Date(now.getTime() - 1))
  providerLookups.status = 503
  const reconciler = createPaymentReconciler(
    db,
    new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs),
    config,
  )

  await reconciler.runDue(now)
  await reconciler.runDue(new Date(now.getTime() + 10000))

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'pending')
  assert.equal((await db('stock_reservations').where({ payment_id: paymentId }).first()).status, 'active')
  assert.equal(
    await db('payment_incidents')
      .where({ payment_id: paymentId, code: 'expired_payment_status_unavailable' })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    1,
  )
  assert.equal(
    await db('notification_outbox')
      .where({ notification_type: 'admin_incident' })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    1,
  )
  const attempts = await db('payment_reconciliation_attempts')
    .where({ payment_id: paymentId })
    .orderBy('attempt_number')
  assert.equal(attempts.length, 2)
  assert.deepEqual(
    attempts.map((attempt) => attempt.outcome),
    ['provider_lookup_failed', 'provider_lookup_failed'],
  )
  assert.isNotNull(attempts[0]?.completed_at)
  assert.include(attempts[0]?.redacted_details, 'HTTP 503')
})

test('a webhook wins when it commits during an in-flight expiry status lookup', async ({
  assert,
  client,
}) => {
  const { db, config, providerLookups } = useApiFixture()
  const now = new Date()
  const { paymentId, reference } = await makePendingPayment(db, new Date(now.getTime() - 1))
  providerLookups.status = 200
  providerLookups.delayMs = 100
  providerLookups.payment = {
    amount: 250000,
    currency: 'NGN',
    status: 'pending',
    checkout_expires_at: new Date(now.getTime() - 1).toISOString(),
  }
  const reconciler = createPaymentReconciler(
    db,
    new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs),
    config,
  )
  const reconciliation = reconciler.runDue(now)
  for (let attempt = 0; attempt < 50 && !providerLookups.started; attempt += 1)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2))
  assert.isTrue(providerLookups.started)
  const event = {
    event_id: 'provider-expiry-race-0001',
    event_type: 'payment.success',
    status: 'success',
    reference,
    provider_reference: 'provider-won-race',
    amount: 250000,
    currency: 'NGN',
    occurred_at: now.toISOString(),
  }
  const signature = `sha256=${createHmac('sha256', config.providerWebhookSecret).update(JSON.stringify(event)).digest('hex')}`
  const webhook = await client
    .post('/v1/webhooks/payment')
    .header('X-Provider-Signature', signature)
    .json(event)
  assert.equal(webhook.body().data.outcome, 'processed')
  await reconciliation

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'success')
  assert.equal(
    await db('fulfillments')
      .where({ payment_id: paymentId })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    1,
  )
  assert.equal(
    await db('payment_incidents')
      .where({ payment_id: paymentId, code: 'payment_expired_provider_pending' })
      .count({ count: '*' })
      .then((rows) => Number(rows[0]?.count)),
    0,
  )
  const attempt = await db('payment_reconciliation_attempts').where({ payment_id: paymentId }).first()
  assert.equal(attempt.outcome, 'payment_already_terminal')
  assert.include(attempt.redacted_details, 'already success')
})
