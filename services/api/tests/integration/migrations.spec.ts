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
