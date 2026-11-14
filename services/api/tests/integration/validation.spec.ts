import { test } from '@japa/runner'

test('VineJS rejects malformed, unknown, and out-of-range request data before route work', async ({
  assert,
  client,
}) => {
  const unknownLoginField = await client.post('/v1/login').json({ user_id: 1, is_admin: true })
  const stringUserId = await client.post('/v1/login').json({ user_id: '1' })
  assert.equal(unknownLoginField.status(), 400)
  assert.equal(stringUserId.status(), 400)

  const login = await client.post('/v1/login').json({ user_id: 1 })
  const token = login.body().data.token as string
  const invalidPage = await client.get('/v1/products?page=0').header('Authorization', `Bearer ${token}`)
  const unknownCartField = await client
    .post('/v1/cart')
    .header('Authorization', `Bearer ${token}`)
    .json({
      items: [{ product_id: 1, quantity: 1 }],
      currency: 'USD',
    })
  const invalidCheckoutKey = await client
    .post('/v1/cart/checkout')
    .header('Authorization', `Bearer ${token}`)
    .header('Idempotency-Key', 'bad key')
    .json({})

  assert.equal(invalidPage.status(), 400)
  assert.equal(unknownCartField.status(), 400)
  assert.equal(invalidCheckoutKey.status(), 400)
})
