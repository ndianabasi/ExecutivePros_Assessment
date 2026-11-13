import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import knex from 'knex'
import express from 'express'
import { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import configFile from '../../knexfile.js'
import { loadConfig } from '../../src/config.js'
import { createApp } from '../../src/app.js'
import { ProviderClient } from '../../src/provider.js'

test('checkout persists reservations and returns one provider attempt for idempotent retries', async ({ assert }) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-checkout-'))
  const db = knex({
    ...configFile,
    connection: { filename: join(directory, 'api.db') },
    migrations: { directory: resolve('database/migrations'), extension: 'ts' },
    seeds: { directory: resolve('database/seeds'), extension: 'ts' },
  })
  await db.migrate.latest()
  await db.seed.run()
  await db('users').insert({ id: 3, first_name: 'Other', last_name: 'User', email: 'other.user@example.test', role: 'user', is_active: true })
  let initCalls = 0
  const providerServer = express()
  providerServer.use(express.json())
  providerServer.get('/failure-scenarios', (_request, response) => response.json({ data: [{ code: 'PROVIDER_001', name: 'Delayed', description: 'Delayed initialization' }] }))
  providerServer.post('/payments/initialise', (request, response) => {
    initCalls += 1
    response.status(201).json({ data: {
      reference: request.body.reference,
      provider_reference: 'provider-1',
      amount: request.body.amount,
      currency: request.body.currency,
      status: 'pending',
      payment_url: 'http://127.0.0.1:8082/checkout/opaque-token',
      checkout_expires_at: request.body.checkout_expires_at,
    } })
  })
  const providerListener = providerServer.listen(0, '127.0.0.1')
  await once(providerListener, 'listening')
  const providerAddress = providerListener.address()
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('Expected a TCP provider fixture listener')
  const config = loadConfig({
    NODE_ENV: 'test', PORT: '3000', API_DB_PATH: '/data/api.db', API_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    FRONTEND_ORIGIN: 'http://127.0.0.1:8080', DOCS_ORIGIN: 'http://127.0.0.1:8081',
    PROVIDER_BASE_URL: `http://127.0.0.1:${providerAddress.port}`, PROVIDER_PUBLIC_ORIGIN: 'http://127.0.0.1:8082',
    QUEUE_BASE_URL: 'http://queue:3000', PROVIDER_WEBHOOK_SECRET: 'a'.repeat(32),
    PROVIDER_SERVICE_SECRET: 'b'.repeat(32), QUEUE_SERVICE_SECRET: 'c'.repeat(32),
    PROVIDER_TIMEOUT_MS: '1000', PROVIDER_INIT_BACKOFF_MS: '1',
  })
  const app = createApp({
    db, isReady: () => true, frontendOrigin: config.frontendOrigin, docsOrigin: config.docsOrigin,
    provider: new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs), config,
  })
  const apiListener = app.listen(0, '127.0.0.1')
  await once(apiListener, 'listening')
  const apiAddress = apiListener.address()
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('Expected a TCP API fixture listener')
  const client = new ApiClient(`http://127.0.0.1:${apiAddress.port}`)
  try {
    const login = await client.post('/v1/login').json({ user_id: 1 })
    const token = login.body().data.token as string
    const scenarios = await client.get('/v1/failure-scenarios').header('Authorization', `Bearer ${token}`)
    assert.equal(scenarios.body().data[0].code, 'PROVIDER_001')
    const missingKey = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).json({})
    assert.equal(missingKey.status(), 400)
    await client.post('/v1/cart').header('Authorization', `Bearer ${token}`).json({ items: [{ product_id: 1, quantity: 2 }] })
    const first = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0001').json({ failure_scenario_code: 'PROVIDER_001' })
    assert.equal(first.status(), 201)
    assert.equal(first.body().data.amount_minor, 500000)
    assert.equal(first.body().data.payment_url, 'http://127.0.0.1:8082/checkout/opaque-token')
    assert.equal(await db('payments').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
    assert.equal(await db('stock_reservations').where({ status: 'active' }).sum({ quantity: 'quantity' }).then((rows) => Number(rows[0]?.quantity)), 2)

    const otherLogin = await client.post('/v1/login').json({ user_id: 3 })
    const otherToken = otherLogin.body().data.token as string
    const exhaustedStock = await client.post('/v1/cart').header('Authorization', `Bearer ${otherToken}`).json({ items: [{ product_id: 1, quantity: 19 }] })
    assert.equal(exhaustedStock.status(), 409)

    const replay = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0001').json({ failure_scenario_code: 'PROVIDER_001' })
    assert.equal(replay.status(), 200)
    assert.equal(replay.body().data.id, first.body().data.id)
    assert.equal(initCalls, 1)

    const conflict = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0001').json({})
    assert.equal(conflict.status(), 409)
    const secondKey = await client.post('/v1/cart/checkout').header('Authorization', `Bearer ${token}`).header('Idempotency-Key', 'checkout-key-0002').json({ failure_scenario_code: 'PROVIDER_001' })
    assert.equal(secondKey.status(), 200)
    assert.equal(secondKey.body().data.id, first.body().data.id)
    assert.equal(await db('payments').count({ count: '*' }).then((rows) => Number(rows[0]?.count)), 1)
  } finally {
    apiListener.close()
    providerListener.close()
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
