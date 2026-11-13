import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import knex from 'knex'
import { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import config from '../../knexfile.js'
import { createApp } from '../../src/app.js'

test('cart routes create, update, retrieve, remove items, and enforce owner access', async ({ assert }) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-cart-'))
  const db = knex({
    ...config,
    connection: { filename: join(directory, 'api.db') },
    migrations: { directory: resolve('database/migrations'), extension: 'ts' },
    seeds: { directory: resolve('database/seeds'), extension: 'ts' },
  })
  await db.migrate.latest()
  await db.seed.run()
  await db('users').insert({ id: 3, first_name: 'Other', last_name: 'User', email: 'other.user@example.test', role: 'user', is_active: true })
  const server = createApp({ db, isReady: () => true, frontendOrigin: 'http://127.0.0.1:8080', docsOrigin: 'http://127.0.0.1:8081' }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test listener')
  const client = new ApiClient(`http://127.0.0.1:${address.port}`)
  try {
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
  } finally {
    server.close()
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
