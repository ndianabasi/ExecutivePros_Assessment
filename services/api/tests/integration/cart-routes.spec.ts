import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('cart routes create, update, retrieve, remove items, and enforce owner access', async ({ assert, client }) => {
    useApiFixture()
    const login = await client.post('/v1/login').json({ user_id: 1 })
    const token = login.body().data.token as string
    const invalidItem = await client.post('/v1/cart').header('Authorization', `Bearer ${token}`).json({ items: [{ product_id: 999, quantity: 1 }] })
    assert.equal(invalidItem.status(), 409)
    assert.equal(invalidItem.body().error.request_id, invalidItem.header('x-request-id'))
    const empty = await client.get('/v1/cart').header('Authorization', `Bearer ${token}`)
    assert.equal(empty.body().data, null)

    const created = await client.post('/v1/cart').header('Authorization', `Bearer ${token}`).json({ items: [{ product_id: 1, quantity: 2 }] })
    assert.equal(created.status(), 200)
    assert.equal(created.body().data.items[0].quantity, 2)
    assert.equal(created.body().data.total_minor, 500000)
    const cartId = created.body().data.id as number

    const changed = await client.patch('/v1/cart/items/1').header('Authorization', `Bearer ${token}`).json({ quantity: 3 })
    assert.equal(changed.body().data.items[0].quantity, 3)
    assert.equal(changed.body().data.total_minor, 750000)
    const detail = await client.get(`/v1/carts/${cartId}`).header('Authorization', `Bearer ${token}`)
    assert.equal(detail.status(), 200)
    const denied = await client.get(`/v1/carts/${cartId}`).header('Authorization', `Bearer ${(await client.post('/v1/login').json({ user_id: 3 })).body().data.token}`)
    assert.equal(denied.status(), 404)

    const removed = await client.delete('/v1/cart/items/1').header('Authorization', `Bearer ${token}`)
    assert.equal(removed.status(), 204)
    assert.equal((await client.get('/v1/cart').header('Authorization', `Bearer ${token}`)).body().data.items.length, 0)
    assert.equal((await client.delete('/v1/cart').header('Authorization', `Bearer ${token}`)).status(), 204)
    assert.equal((await client.get('/v1/cart').header('Authorization', `Bearer ${token}`)).body().data, null)
})
