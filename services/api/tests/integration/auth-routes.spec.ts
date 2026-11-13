import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import knex from 'knex'
import { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import config from '../../knexfile.js'
import { createApp } from '../../src/app.js'

test('public discovery, passwordless login, protected products, and logout route work', async ({ assert }) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-routes-'))
  const db = knex({
    ...config,
    connection: { filename: join(directory, 'api.db') },
    migrations: { directory: resolve('database/migrations'), extension: 'ts' },
    seeds: { directory: resolve('database/seeds'), extension: 'ts' },
  })
  await db.migrate.latest()
  await db.seed.run()
  const app = createApp({
    db,
    isReady: () => true,
    frontendOrigin: 'http://127.0.0.1:8080',
    docsOrigin: 'http://127.0.0.1:8081',
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test listener')
  const client = new ApiClient(`http://127.0.0.1:${address.port}`)

  try {
    const discovered = await client.get('/v1/demo/users')
    assert.equal(discovered.status(), 200)
    assert.equal(discovered.body().data.length, 2)

    const unauthorized = await client.get('/v1/products')
    assert.equal(unauthorized.status(), 401)

    const loggedIn = await client.post('/v1/login').json({ user_id: 1 })
    assert.equal(loggedIn.status(), 200)
    const token = loggedIn.body().data.token as string
    const products = await client.get('/v1/products').header('Authorization', `Bearer ${token}`)
    assert.equal(products.status(), 200)
    assert.equal(products.body().data.length, 3)
    assert.equal(products.header('cache-control'), 'no-store')

    const signedOut = await client.post('/v1/logout').header('Authorization', `Bearer ${token}`)
    assert.equal(signedOut.status(), 204)
    const rejected = await client.get('/v1/products').header('Authorization', `Bearer ${token}`)
    assert.equal(rejected.status(), 401)
  } finally {
    server.close()
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
