import { createHmac } from 'node:crypto'
import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('signed payment success commits fulfilment, stock consumption, and one email intent atomically', async ({ assert, client }) => {
  const { db, config } = await useApiFixture()
  const [cartIdRaw] = await db('carts').insert({ user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 250000 })
  const cartId = Number(cartIdRaw)
  await db('cart_items').insert({ cart_id: cartId, product_id: 1, product_name: 'Demo notebook', unit_price_minor: 250000, currency: 'NGN', quantity: 1, line_total_minor: 250000 })
  const reference = 'pay_abcdefghijklmnop'
  const [paymentIdRaw] = await db('payments').insert({ user_id: 1, cart_id: cartId, reference, status: 'pending', amount_minor: 250000, currency: 'NGN', checkout_expires_at: new Date(Date.now() + 86400000).toISOString() })
  const paymentId = Number(paymentIdRaw)
  await db('stock_reservations').insert({ payment_id: paymentId, product_id: 1, quantity: 1, status: 'active' })

  const secret = config.providerWebhookSecret
    const event = {
      event_id: 'provider-event-0001', event_type: 'payment.success', status: 'success', reference,
      provider_reference: 'provider-tx-1', amount: 250000, currency: 'NGN', occurred_at: new Date().toISOString(),
    }
    const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(event)).digest('hex')}`
    const accepted = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', signature).json(event)
    assert.equal(accepted.status(), 200)
    assert.equal(accepted.body().data.outcome, 'processed')
    assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'success')
    assert.equal((await db('carts').where({ id: cartId }).first()).status, 'paid')
    assert.equal((await db('products').where({ id: 1 }).first()).stock_quantity, 19)
    assert.equal((await db('stock_reservations').where({ payment_id: paymentId }).first()).status, 'consumed')
    assert.equal(await db('fulfillments').where({ payment_id: paymentId }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
    assert.equal(await db('notification_outbox').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
    const paymentRead = await client.get(`/v1/payments/${paymentId}`).header('Authorization', `Bearer ${(await client.post('/v1/login').json({ user_id: 1 })).body().data.token}`)
    assert.equal(paymentRead.status(), 200)
    assert.equal(paymentRead.body().data.fulfillment.items[0].product_name, 'Demo notebook')

    const duplicate = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', signature).json(event)
    assert.equal(duplicate.status(), 200)
    assert.equal(duplicate.body().data.outcome, 'duplicate')
    assert.equal(await db('fulfillments').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)

    const conflictEvent = { ...event, event_id: 'provider-event-0002', event_type: 'payment.failed', status: 'failed' }
    const conflictSignature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(conflictEvent)).digest('hex')}`
    const conflict = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', conflictSignature).json(conflictEvent)
    assert.equal(conflict.status(), 200)
    assert.equal(conflict.body().data.outcome, 'terminal_conflict')
    assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'success')
    assert.equal(await db('payment_incidents').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
    assert.equal(await db('notification_outbox').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 2)

    const invalidSignature = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', 'sha256=' + '0'.repeat(64)).json({ ...event, event_id: 'invalid-sig-0001' })
    assert.equal(invalidSignature.status(), 401)
    assert.equal(await db('payment_incidents').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 2)
})

test('late provider success after terminal expiry stays failed and creates one admin incident', async ({ assert, client }) => {
  const { db, config } = await useApiFixture()
  const [cartIdRaw] = await db('carts').insert({ user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 250000 })
  const [paymentIdRaw] = await db('payments').insert({ user_id: 1, cart_id: Number(cartIdRaw), reference: 'pay_late_success0001',
    status: 'failed', amount_minor: 250000, currency: 'NGN', checkout_expires_at: new Date(0).toISOString(), completed_at: new Date().toISOString() })
  const paymentId = Number(paymentIdRaw)
  const event = { event_id: 'provider-late-success-0001', event_type: 'payment.success', status: 'success', reference: 'pay_late_success0001',
    provider_reference: 'provider-late-success', amount: 250000, currency: 'NGN', occurred_at: new Date().toISOString() }
  const signature = `sha256=${createHmac('sha256', config.providerWebhookSecret).update(JSON.stringify(event)).digest('hex')}`

  const first = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', signature).json(event)
  const duplicate = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', signature).json(event)

  assert.equal(first.body().data.outcome, 'late_success')
  assert.equal(duplicate.body().data.outcome, 'duplicate')
  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'failed')
  assert.equal(await db('fulfillments').where({ payment_id: paymentId }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 0)
  assert.equal(await db('payment_incidents').where({ payment_id: paymentId, code: 'late_provider_success' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal(await db('notification_outbox').where({ notification_type: 'admin_incident' }).count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
})
