import { test } from '@japa/runner'
import { ProviderClient } from '../../src/provider.js'
import { createPaymentReconciler } from '../../src/reconciliation.js'
import { useApiFixture } from '../macros.js'

async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error('The real provider checkout did not reach the expected API state')
}

test('real test-mode provider checkout delivers a signed webhook and fulfils once', async ({ assert, client }) => {
  const { db, config } = await useApiFixture()
  const login = await client.post('/v1/login').json({ user_id: 1 })
  assert.equal(login.status(), 200)
  const token = login.body().data.token as string
  const auth = `Bearer ${token}`

  const cart = await client.post('/v1/cart').header('Authorization', auth).json({ items: [{ product_id: 1, quantity: 2 }] })
  assert.equal(cart.status(), 200)
  const checkout = await client.post('/v1/cart/checkout')
    .header('Authorization', auth)
    .header('Idempotency-Key', 'real-provider-e2e-0001')
    .json({ failure_scenario_code: 'WEBHOOK_001' })
  assert.equal(checkout.status(), 201)
  assert.equal(checkout.body().data.status, 'pending')
  const paymentId = checkout.body().data.id as number
  const paymentUrl = checkout.body().data.payment_url as string
  assert.equal(new URL(paymentUrl).origin, config.providerPublicOrigin)

  const checkoutPage = await fetch(paymentUrl)
  const html = await checkoutPage.text()
  assert.equal(checkoutPage.status, 200)
  assert.isTrue(checkoutPage.headers.get('content-security-policy')?.includes(`frame-ancestors ${config.frontendOrigin}`))
  assert.isTrue(html.includes('Pay successfully'))
  const checkoutToken = new URL(paymentUrl).pathname.split('/').at(-1)
  assert.isTrue(Boolean(checkoutToken))
  const completed = await fetch(`${config.providerPublicOrigin}/payments/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ checkout_token: checkoutToken!, outcome: 'success' }),
  })
  assert.equal(completed.status, 200)
  assert.isTrue((await completed.text()).includes('data-parent-message="true"'))

  let payment: { data: { status: string; fulfillment: { items: unknown[] } | null } } | undefined
  await waitFor(async () => {
    const response = await client.get(`/v1/payments/${paymentId}`).header('Authorization', auth)
    if (response.status() !== 200) return false
    payment = response.body() as typeof payment
    return payment?.data.status === 'success'
  })
  assert.equal(payment?.data.status, 'success')
  assert.equal(payment?.data.fulfillment?.items.length, 1)
  assert.equal(await db('fulfillments').where({ payment_id: paymentId }).count({ count: '*' }).first().then((row) => Number(row?.count)), 1)
  assert.equal(await db('fulfillment_items').count({ count: '*' }).first().then((row) => Number(row?.count)), 1)
  assert.equal(await db('products').where({ id: 1 }).select('stock_quantity').first().then((row) => Number(row?.stock_quantity)), 18)
  assert.equal(await db('provider_events').where({ reference: checkout.body().data.reference, source: 'webhook', outcome: 'success' }).count({ count: '*' }).first().then((row) => Number(row?.count)), 1)
  assert.equal(await db('notification_outbox').where({ notification_type: 'payment_success' }).count({ count: '*' }).first().then((row) => Number(row?.count)), 1)

  const providerStatus = await fetch(`${config.providerBaseUrl}/payments/${encodeURIComponent(checkout.body().data.reference)}`, {
    headers: { Authorization: `Bearer ${config.providerServiceSecret}` },
  })
  assert.equal(providerStatus.status, 200)
  assert.equal((await providerStatus.json() as { data: { status: string } }).data.status, 'success')
})

test('real provider status reconciliation recovers a deliberately skipped webhook', async ({ assert, client }) => {
  const { db, config } = await useApiFixture()
  const login = await client.post('/v1/login').json({ user_id: 1 })
  const auth = `Bearer ${login.body().data.token as string}`
  const cart = await client.post('/v1/cart').header('Authorization', auth).json({ items: [{ product_id: 1, quantity: 1 }] })
  assert.equal(cart.status(), 200)
  const checkout = await client.post('/v1/cart/checkout').header('Authorization', auth)
    .header('Idempotency-Key', 'real-provider-missed-webhook-0001').json({ failure_scenario_code: 'WEBHOOK_004' })
  assert.equal(checkout.status(), 201)
  const paymentId = checkout.body().data.id as number
  const reference = checkout.body().data.reference as string
  const checkoutToken = new URL(checkout.body().data.payment_url as string).pathname.split('/').at(-1)
  const completed = await fetch(`${config.providerPublicOrigin}/payments/submit`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ checkout_token: checkoutToken!, outcome: 'success' }),
  })
  assert.equal(completed.status, 200)

  const providerClient = new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs)
  const providerStatus = await providerClient.lookup(reference)
  assert.equal(providerStatus.status, 'success')
  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'pending')
  await db('payments').where({ id: paymentId }).update({ reconcile_after: new Date(0).toISOString() })
  const reconciler = createPaymentReconciler(db, providerClient, config)
  await reconciler.runDue()

  assert.equal((await db('payments').where({ id: paymentId }).first()).status, 'success')
  assert.equal(await db('fulfillments').where({ payment_id: paymentId }).count({ count: '*' }).first().then((row) => Number(row?.count)), 1)
  assert.equal(await db('products').where({ id: 1 }).select('stock_quantity').first().then((row) => Number(row?.stock_quantity)), 19)
  assert.equal(await db('provider_events').where({ reference, source: 'reconciliation', outcome: 'success' }).count({ count: '*' }).first().then((row) => Number(row?.count)), 1)
})
