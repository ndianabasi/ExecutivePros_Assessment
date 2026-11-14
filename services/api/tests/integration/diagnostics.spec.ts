import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('diagnostics requires an admin and reports expired payment and outbox backlog counts', async ({ assert, client }) => {
  const { db } = useApiFixture()
  const [cartIdRaw] = await db('carts').insert({ user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 100 })
  await db('payments').insert({ user_id: 1, cart_id: Number(cartIdRaw), reference: 'pay_diagnostics0001', status: 'pending',
    amount_minor: 100, currency: 'NGN', checkout_expires_at: new Date(0).toISOString() })
  const [adminLogin, userLogin] = await Promise.all([
    client.post('/v1/login').json({ user_id: 2 }),
    client.post('/v1/login').json({ user_id: 1 }),
  ])

  assert.equal((await client.get('/v1/admin/diagnostics')).status(), 401)
  assert.equal((await client.get('/v1/admin/diagnostics').header('Authorization', `Bearer ${userLogin.body().data.token}`)).status(), 403)
  const response = await client.get('/v1/admin/diagnostics').header('Authorization', `Bearer ${adminLogin.body().data.token}`)
  assert.equal(response.status(), 200)
  assert.equal(response.body().data.payments.pending_count, 1)
  assert.equal(response.body().data.payments.expired_pending_count, 1)
  assert.equal(response.body().data.notification_outbox.unaccepted_count, 0)
})
