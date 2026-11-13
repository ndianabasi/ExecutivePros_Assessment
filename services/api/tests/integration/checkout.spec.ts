import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('checkout persists reservations and returns one provider attempt for idempotent retries', async ({ assert, client }) => {
  const { db, providerInitCalls } = await useApiFixture()
  const login = await client.post('/v1/login').json({ user_id: 1 })
  const token = login.body().data.token as string
  const scenarios = await client.get('/v1/failure-scenarios').header('Authorization', `Bearer ${token}`)
  assert.equal(scenarios.body().data[0].code, 'PROVIDER_001')
  const missingKey = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).json({})
  assert.equal(missingKey.status(), 400)
  const cart = await client.post('/v1/cart').header('Authorization', `Bearer ${token}`).json({ items: [{ product_id: 1, quantity: 2 }] })
  const cartId = cart.body().data.id as number
  const first = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0001').json({ failure_scenario_code: 'PROVIDER_001' })
  assert.equal(first.status(), 201)
  assert.equal(first.body().data.amount_minor, 500000)
  assert.equal(first.body().data.payment_url, 'http://127.0.0.1:8082/checkout/mock-token')
  assert.equal(await db('payments').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  assert.equal(await db('stock_reservations').where({ status: 'active' }).sum({ quantity: 'quantity' }).then((rows) => Number(rows[0]?.quantity)), 2)
  const products = await client.get('/v1/products').header('Authorization', `Bearer ${token}`)
  assert.equal(products.body().data[0].available_stock, 18)
  const attempts = await client.get(`/v1/carts/${cartId}`).header('Authorization', `Bearer ${token}`)
  assert.equal(attempts.body().data.payments.length, 1)
  const ownPayments = await client.get('/v1/payments').header('Authorization', `Bearer ${token}`)
  assert.equal(ownPayments.body().meta.total, 1)
  assert.equal(ownPayments.body().data[0].payment_url, 'http://127.0.0.1:8082/checkout/mock-token')
  assert.equal(ownPayments.header('cache-control'), 'no-store')

  const otherLogin = await client.post('/v1/login').json({ user_id: 3 })
  const otherToken = otherLogin.body().data.token as string
  const exhaustedStock = await client.post('/v1/cart').header('Authorization', `Bearer ${otherToken}`).json({ items: [{ product_id: 1, quantity: 19 }] })
  assert.equal(exhaustedStock.status(), 409)
  const hiddenPayment = await client.get(`/v1/payments/${first.body().data.id}`).header('Authorization', `Bearer ${otherToken}`)
  assert.equal(hiddenPayment.status(), 404)
  assert.equal((await client.get('/v1/payments').header('Authorization', `Bearer ${otherToken}`)).body().meta.total, 0)
  const adminLogin = await client.post('/v1/login').json({ user_id: 2 })
  const adminToken = adminLogin.body().data.token as string
  assert.equal((await client.get('/v1/payments').header('Authorization', `Bearer ${adminToken}`)).body().meta.total, 1)

  const replay = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0001').json({ failure_scenario_code: 'PROVIDER_001' })
  assert.equal(replay.status(), 200)
  assert.equal(replay.body().data.id, first.body().data.id)
  assert.equal(providerInitCalls.count, 1)

  const conflict = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0001').json({})
  assert.equal(conflict.status(), 409)
  const secondKey = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0002').json({ failure_scenario_code: 'PROVIDER_001' })
  assert.equal(secondKey.status(), 200)
  assert.equal(secondKey.body().data.id, first.body().data.id)
  assert.equal(await db('payments').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
})
