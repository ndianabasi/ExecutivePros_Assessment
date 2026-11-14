import { createHmac } from 'node:crypto'
import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('payment SSE sends committed status only to the payment owner and closes cleanly', async ({ assert, client }) => {
  const { db, config, apiPort } = await useApiFixture()
  const ownerLogin = await client.post('/v1/login').json({ user_id: 1 })
  const otherLogin = await client.post('/v1/login').json({ user_id: 3 })
  const ownerToken = ownerLogin.body().data.token as string
  const otherToken = otherLogin.body().data.token as string
  const unauthorized = await fetch(`http://127.0.0.1:${apiPort}/v1/events`)
  assert.equal(unauthorized.status, 401)

  const cartId = Number((await db('carts').insert({ user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 250000 }))[0])
  await db('cart_items').insert({ cart_id: cartId, product_id: 1, product_name: 'Demo notebook', unit_price_minor: 250000, currency: 'NGN', quantity: 1, line_total_minor: 250000 })
  const reference = 'pay_sse_owner_scope_00000001'
  const [paymentId] = await db('payments').insert({ user_id: 1, cart_id: cartId, reference, status: 'pending', amount_minor: 250000, currency: 'NGN', checkout_expires_at: new Date(Date.now() + 86400000).toISOString() })
  await db('stock_reservations').insert({ payment_id: paymentId, product_id: 1, quantity: 1, status: 'active' })

  const ownerResponse = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${ownerToken}` } })
  const otherResponse = await fetch(`http://127.0.0.1:${apiPort}/v1/events`, { headers: { authorization: `Bearer ${otherToken}` } })
  assert.equal(ownerResponse.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(ownerResponse.headers.get('cache-control'), 'no-cache, no-store, must-revalidate')
  const ownerReader = ownerResponse.body!.getReader()
  const otherReader = otherResponse.body!.getReader()
  await ownerReader.read()
  await otherReader.read()
  const ownerNext = ownerReader.read()
  const event = { event_id: 'provider-sse-owner-event-0001', event_type: 'payment.success', status: 'success', reference,
    provider_reference: 'provider-sse-owner-0001', amount: 250000, currency: 'NGN', occurred_at: new Date().toISOString() }
  const signature = `sha256=${createHmac('sha256', config.providerWebhookSecret).update(JSON.stringify(event)).digest('hex')}`
  const accepted = await client.post('/v1/webhooks/payment').header('X-Provider-Signature', signature).json(event)
  assert.equal(accepted.status(), 200)

  const packet = await ownerNext
  const text = new TextDecoder().decode(packet.value)
  assert.isTrue(text.includes('event: payment'))
  assert.isTrue(text.includes(reference))
  const data = JSON.parse(text.split('data: ')[1]!.split('\n')[0]!) as { payment_id: number; reference: string; status: string; event_id: string; request_id: string }
  assert.equal(data.payment_id, Number(paymentId))
  assert.equal(data.status, 'success')
  assert.equal(data.event_id, event.event_id)
  assert.isTrue(Boolean(data.request_id))

  const otherNext = otherReader.read()
  const otherPacket = await Promise.race([otherNext.then((value) => value), new Promise<null>((resolveWait) => setTimeout(() => resolveWait(null), 75))])
  assert.isNull(otherPacket)
  await ownerReader.cancel()
  await otherReader.cancel()
})
