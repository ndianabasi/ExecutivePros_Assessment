import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import knex from 'knex'
import { test } from '@japa/runner'
import config from '../../knexfile.js'

test('migrates a file database and seeds demo records idempotently', async ({ assert }) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-migration-'))
  const filename = join(directory, 'api.db')
  const db = knex({
    ...config,
    connection: { filename },
    migrations: { directory: resolve('database/migrations'), extension: 'ts' },
    seeds: { directory: resolve('database/seeds'), extension: 'ts' },
  })

  try {
    const first = await db.migrate.latest()
    const second = await db.migrate.latest()
    await db.seed.run()
    await db.seed.run()
    const users = await db('users').count<{ count: number }[]>({ count: '*' }).first()
    const products = await db('products').count<{ count: number }[]>({ count: '*' }).first()

    assert.equal(first[1].length, 1)
    assert.equal(second[1].length, 0)
    assert.equal(Number(users?.count), 2)
    assert.equal(Number(products?.count), 3)
  } finally {
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite schema enforces cart quantity, unique payment reference, and one pending payment per cart', async ({ assert }) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-constraints-'))
  const db = knex({
    ...config,
    connection: { filename: join(directory, 'api.db') },
    migrations: { directory: resolve('database/migrations'), extension: 'ts' },
    seeds: { directory: resolve('database/seeds'), extension: 'ts' },
  })
  await db.migrate.latest()
  await db.seed.run()

  try {
    const cartId = Number((await db('carts').insert({ user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 250000 }))[0])
    await assert.rejects(() => db('cart_items').insert({ cart_id: cartId, product_id: 1, product_name: 'Demo notebook', unit_price_minor: 250000, quantity: 0, line_total_minor: 0 }))
    const payment = {
      user_id: 1, cart_id: cartId, reference: 'test-payment-1', status: 'pending', amount_minor: 250000,
      currency: 'NGN', checkout_expires_at: new Date(Date.now() + 86400000).toISOString(),
    }
    await db('payments').insert(payment)
    await assert.rejects(() => db('payments').insert({ ...payment, reference: 'test-payment-2' }))
    await assert.rejects(() => db('payments').insert({ ...payment, cart_id: cartId + 100, reference: 'test-payment-1' }))
    assert.equal(await db('fulfillments').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 0)
  } finally {
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
