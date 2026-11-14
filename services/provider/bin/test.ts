import '../src/load-test-env.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import express from 'express'
import { apiClient } from '@japa/api-client'
import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'
import type { Test } from '@japa/runner/core'
import knex from 'knex'
import Database from 'better-sqlite3'
import { createDatabase as createWorkmaticDatabase } from 'workmatic'
import knexFile from '../knexfile.js'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/app.js'
import { verifyProviderDatabase } from '../src/db.js'
import { createWebhookRuntime } from '../src/webhooks.js'
import type { ProviderTestFixture } from '../tests/macros.js'
import '../tests/macros.js'

const providerPort = Number(process.env.PROVIDER_TEST_PORT)
const apiPort = Number(process.env.API_TEST_PORT)
if (!Number.isSafeInteger(providerPort) || providerPort < 40000 || providerPort > 65535 ||
    !Number.isSafeInteger(apiPort) || apiPort < 40000 || apiPort > 65535 || providerPort === apiPort) {
  throw new Error('PROVIDER_TEST_PORT and API_TEST_PORT must be distinct ports from .env.test between 40000 and 65535')
}

async function listen(server: Server, port: number) {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
}
async function close(server?: Server) {
  if (!server?.listening) return
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
}

async function setupProviderTest(testCase: Test) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-japa-'))
  const dbPath = join(directory, 'payment_provider.db')
  const db = knex({ ...knexFile, connection: { filename: dbPath }, migrations: { directory: resolve('database/migrations'), extension: 'ts' }, seeds: { directory: resolve('database/seeds'), extension: 'ts' } })
  let native: Database.Database | undefined
  let workmatic: ReturnType<typeof createWorkmaticDatabase> | undefined
  let providerServer: Server | undefined
  let apiServer: Server | undefined
  let runtime: ReturnType<typeof createWebhookRuntime> | undefined
  let sweep: NodeJS.Timeout | undefined
  const api = { received: [] as Array<{ body: Buffer; signature: string; requestId: string }>, responseStatus: 204 }
  try {
    await db.migrate.latest()
    await db.seed.run()
    native = new Database(dbPath)
    native.pragma('foreign_keys = ON')
    native.pragma('busy_timeout = 5000')
    native.pragma('journal_mode = WAL')
    workmatic = createWorkmaticDatabase({ db: native })
    const config = loadConfig({
      NODE_ENV: 'test', PORT: String(providerPort), PROVIDER_DB_PATH: dbPath,
      PROVIDER_PUBLIC_ORIGIN: `http://127.0.0.1:${providerPort}`, FRONTEND_ORIGIN: `http://127.0.0.1:${apiPort}`,
      API_WEBHOOK_URL: `http://127.0.0.1:${apiPort}/v1/webhooks/payment`,
      PROVIDER_SERVICE_SECRET: 'p'.repeat(32), PROVIDER_WEBHOOK_SECRET: 'w'.repeat(32),
      PROVIDER_INIT_DELAY_MS: '20', WEBHOOK_DELAY_MS: '20', WEBHOOK_COPY_INTERVAL_MS: '1',
      WEBHOOK_RETRY_INITIAL_MS: '10', WEBHOOK_HTTP_TIMEOUT_MS: '250', WEBHOOK_JOB_TIMEOUT_MS: '1000', WEBHOOK_LEASE_MS: '1500',
      WEBHOOK_POLL_MS: '10', WEBHOOK_SWEEP_INTERVAL_MS: '20', SQLITE_LOCK_BACKOFF_MS: '1', SHUTDOWN_GRACE_MS: '5000',
    })
    const apiApp = express()
    apiApp.use('/v1/webhooks/payment', express.raw({ type: 'application/json', limit: '32kb' }))
    apiApp.post('/v1/webhooks/payment', (request, response) => {
      api.received.push({ body: Buffer.from(request.body as Buffer), signature: request.header('x-provider-signature') ?? '', requestId: request.header('x-request-id') ?? '' })
      response.status(api.responseStatus).end()
    })
    apiServer = createServer(apiApp)
    await listen(apiServer, apiPort)

    runtime = createWebhookRuntime(db, workmatic, config)
    runtime.worker.start()
    const app = createApp({ db, config, isReady: () => verifyProviderDatabase(db, config, native!, workmatic!), worker: runtime.worker, scheduleDueEvents: runtime.scheduleDueEvents })
    providerServer = createServer(app)
    await listen(providerServer, providerPort)
    await runtime.scheduleDueEvents()
    sweep = setInterval(() => { void runtime?.scheduleDueEvents() }, 20)
    const fixture: ProviderTestFixture = { db, config, api, runtime, providerPort, apiPort }
    testCase.context.providerFixture = fixture
    return async () => {
      clearInterval(sweep)
      await close(providerServer)
      await close(apiServer)
      await runtime?.worker.stop()
      await workmatic?.destroy()
      if (native?.open) native.close()
      await db.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    clearInterval(sweep)
    await close(providerServer)
    await close(apiServer)
    await runtime?.worker.stop()
    await workmatic?.destroy()
    if (native?.open) native.close()
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

processCLIArgs(process.argv.splice(2))
configure({
  suites: [
    { name: 'unit', files: ['tests/unit/**/*.spec.ts'] },
    { name: 'integration', files: ['tests/integration/**/*.spec.ts'], configure(suite) { suite.onTest((testCase) => testCase.setup(setupProviderTest)) } },
    { name: 'contract', files: ['tests/contract/**/*.spec.ts'], configure(suite) { suite.onTest((testCase) => testCase.setup(setupProviderTest)) } },
    { name: 'e2e', files: ['tests/e2e/**/*.spec.ts'] },
  ],
  plugins: [assert(), apiClient({ baseURL: `http://127.0.0.1:${providerPort}` })],
})
run()
