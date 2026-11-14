import '../src/load-test-env.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import express from 'express'
import { apiClient } from '@japa/api-client'
import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'
import type { Test } from '@japa/runner/core'
import knex from 'knex'
import configFile from '../knexfile.js'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/app.js'
import { ProviderClient } from '../src/provider.js'
import type { ApiTestFixture } from '../tests/macros.js'
import '../tests/macros.js'

async function listen(server: Server, port: number) {
  if (!server.listening) {
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP Japa fixture listener')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
}

async function runProviderScript(providerDirectory: string, args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['--import=tsx', ...args], { cwd: providerDirectory, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000) })
    child.once('error', rejectChild)
    child.once('exit', (code) => code === 0 ? resolveChild() : rejectChild(new Error(`Provider setup process exited with ${code}: ${stderr.slice(-1000)}`)))
  })
}

async function stopChild(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const waitForExit = (milliseconds: number) => new Promise<boolean>((resolveExit) => {
    const onExit = () => { clearTimeout(timeout); resolveExit(true) }
    const timeout = setTimeout(() => { child.off('exit', onExit); resolveExit(false) }, milliseconds)
    child.once('exit', onExit)
  })
  child.kill('SIGTERM')
  const exited = await waitForExit(5000)
  if (!exited) {
    child.kill('SIGKILL')
    await waitForExit(2000)
  }
}

async function setupApiTest(testCase: Test) {
  const directory = await mkdtemp(join(tmpdir(), 'api-japa-'))
  const db = knex({
    ...configFile,
    connection: { filename: join(directory, 'api.db') },
    migrations: { directory: resolve('database/migrations'), extension: 'ts' },
    seeds: { directory: resolve('database/seeds'), extension: 'ts' },
  })
  let providerServer: Server | undefined
  let apiServer: Server | undefined
  try {
    await db.migrate.latest()
    await db.seed.run()
    await db('users').insert({ id: 3, first_name: 'Other', last_name: 'User', email: 'other.user@example.test', role: 'user', is_active: true })

    const providerApp = express()
    providerApp.use(express.json({ limit: '64kb' }))
    const providerInitCalls = { count: 0 }
    providerApp.use((request, response, next) => {
      if (request.header('authorization') !== `Bearer ${'b'.repeat(32)}`) return response.sendStatus(401)
      next()
    })
    providerApp.get('/failure-scenarios', (_request, response) => response.json({ data: [
      { code: 'PROVIDER_001', name: 'Delayed initialization', description: 'Delay persistence before the provider accepts initialization', category: 'initialization' },
    ] }))
    providerApp.post('/payments/initialise', (request, response) => {
      providerInitCalls.count += 1
      response.status(201).json({ data: {
      reference: request.body.reference,
      provider_reference: `provider_${request.body.reference}`,
      amount: request.body.amount,
      currency: request.body.currency,
      status: 'pending',
      payment_url: `http://127.0.0.1:18082/checkout/mock-token`,
      checkout_expires_at: request.body.checkout_expires_at,
      } })
    })
    providerApp.get('/payments/:reference', (_request, response) => response.sendStatus(404))
    providerServer = createServer(providerApp).listen(providerTestPort, '127.0.0.1')
    const providerUrl = await listen(providerServer, providerTestPort)

    const fixtureConfig = loadConfig({
      NODE_ENV: 'test', PORT: '3000', API_DB_PATH: '/data/api.db',
      API_PUBLIC_ORIGIN: 'http://127.0.0.1:18083', FRONTEND_ORIGIN: 'http://127.0.0.1:18080', DOCS_ORIGIN: 'http://127.0.0.1:18081',
      PROVIDER_BASE_URL: providerUrl, PROVIDER_PUBLIC_ORIGIN: 'http://127.0.0.1:18082',
      QUEUE_BASE_URL: 'http://queue:3000', PROVIDER_WEBHOOK_SECRET: 'a'.repeat(32),
      PROVIDER_SERVICE_SECRET: 'b'.repeat(32), QUEUE_SERVICE_SECRET: 'c'.repeat(32),
      PROVIDER_TIMEOUT_MS: '1000', PROVIDER_INIT_BACKOFF_MS: '1', SQLITE_LOCK_BACKOFF_MS: '1',
    })
    const apiApp = createApp({
      db, isReady: () => true,
      frontendOrigin: fixtureConfig.frontendOrigin, docsOrigin: fixtureConfig.docsOrigin,
      provider: new ProviderClient(fixtureConfig.providerBaseUrl, fixtureConfig.providerServiceSecret, fixtureConfig.providerTimeoutMs),
      config: fixtureConfig,
    })
    apiServer = createServer(apiApp).listen(apiTestPort, '127.0.0.1')
    await listen(apiServer, apiTestPort)
    const apiFixture: ApiTestFixture = { db, config: fixtureConfig, providerInitCalls }
    testCase.context.apiFixture = apiFixture
    return async () => {
      await close(apiServer!)
      await close(providerServer!)
      await db.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    if (apiServer) await close(apiServer)
    if (providerServer) await close(providerServer)
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function setupRealProviderE2E(testCase: Test) {
  testCase.timeout(15000)
  const directory = await mkdtemp(join(tmpdir(), 'api-provider-e2e-'))
  const apiDbPath = join(directory, 'api.db')
  const providerDbPath = join(directory, 'payment_provider.db')
  const db = knex({
    ...configFile,
    connection: { filename: apiDbPath },
    migrations: { directory: resolve('database/migrations'), extension: 'ts' },
    seeds: { directory: resolve('database/seeds'), extension: 'ts' },
  })
  const providerDirectory = resolve(process.cwd(), '../provider')
  const providerPublicOrigin = `http://127.0.0.1:${providerTestPort}`
  const apiOrigin = `http://127.0.0.1:${apiTestPort}`
  const serviceSecret = 'b'.repeat(32)
  const webhookSecret = 'a'.repeat(32)
  const providerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(providerTestPort),
    PROVIDER_DB_PATH: providerDbPath,
    PROVIDER_PUBLIC_ORIGIN: providerPublicOrigin,
    FRONTEND_ORIGIN: apiOrigin,
    API_WEBHOOK_URL: `${apiOrigin}/v1/webhooks/payment`,
    PROVIDER_SERVICE_SECRET: serviceSecret,
    PROVIDER_WEBHOOK_SECRET: webhookSecret,
    PROVIDER_INIT_DELAY_MS: '10',
    WEBHOOK_DELAY_MS: '10',
    WEBHOOK_COPY_INTERVAL_MS: '1',
    WEBHOOK_RETRY_INITIAL_MS: '10',
    WEBHOOK_HTTP_TIMEOUT_MS: '250',
    WEBHOOK_JOB_TIMEOUT_MS: '1000',
    WEBHOOK_LEASE_MS: '1500',
    WEBHOOK_POLL_MS: '10',
    WEBHOOK_SWEEP_INTERVAL_MS: '10',
    SQLITE_LOCK_ATTEMPTS: '5',
    SQLITE_LOCK_BACKOFF_MS: '1',
  }
  let providerProcess: ChildProcess | undefined
  let apiServer: Server | undefined
  let providerOutput = ''
  try {
    await db.migrate.latest()
    await db.seed.run()
    await db('users').insert({ id: 3, first_name: 'Other', last_name: 'User', email: 'other.user@example.test', role: 'user', is_active: true })

    await runProviderScript(providerDirectory, ['bin/migrate.ts', 'up'], providerEnv)
    await runProviderScript(providerDirectory, ['src/initialize.ts'], providerEnv)
    providerProcess = spawn(process.execPath, ['--import=tsx', 'src/server.ts'], { cwd: providerDirectory, env: providerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    providerProcess.stdout?.on('data', (chunk: Buffer) => { providerOutput = `${providerOutput}${chunk.toString('utf8')}`.slice(-4000) })
    providerProcess.stderr?.on('data', (chunk: Buffer) => { providerOutput = `${providerOutput}${chunk.toString('utf8')}`.slice(-4000) })
    let providerStartError: Error | undefined
    providerProcess.once('error', (error) => { providerStartError = error })

    const fixtureConfig = loadConfig({
      NODE_ENV: 'test', PORT: String(apiTestPort), API_DB_PATH: '/data/api.db',
      API_PUBLIC_ORIGIN: apiOrigin, FRONTEND_ORIGIN: apiOrigin, DOCS_ORIGIN: 'http://127.0.0.1:18081',
      PROVIDER_BASE_URL: providerPublicOrigin, PROVIDER_PUBLIC_ORIGIN: providerPublicOrigin,
      QUEUE_BASE_URL: 'http://queue:3000', PROVIDER_WEBHOOK_SECRET: webhookSecret,
      PROVIDER_SERVICE_SECRET: serviceSecret, QUEUE_SERVICE_SECRET: 'c'.repeat(32),
      PROVIDER_TIMEOUT_MS: '2000', PROVIDER_INIT_BACKOFF_MS: '1', SQLITE_LOCK_BACKOFF_MS: '1',
    })
    let providerReady = false
    let lastProviderHealth = 'connection refused'
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (providerStartError) throw providerStartError
      if (providerProcess.exitCode !== null) throw new Error(`Test-mode provider exited before readiness (${providerProcess.exitCode}): ${providerOutput.slice(-1000)}`)
      try {
        const response = await fetch(`${providerPublicOrigin}/health/ready`, { signal: AbortSignal.timeout(250) })
        lastProviderHealth = `HTTP ${response.status}`
        if (response.ok) { providerReady = true; break }
      } catch { /* Poll until the provider server has bound its configured test port. */ }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    }
    if (!providerReady) throw new Error(`Test-mode provider did not become ready (${lastProviderHealth}): ${providerOutput.slice(-1000)}`)

    const apiApp = createApp({
      db, isReady: () => true,
      frontendOrigin: fixtureConfig.frontendOrigin, docsOrigin: fixtureConfig.docsOrigin,
      provider: new ProviderClient(fixtureConfig.providerBaseUrl, fixtureConfig.providerServiceSecret, fixtureConfig.providerTimeoutMs),
      config: fixtureConfig,
    })
    apiServer = createServer(apiApp)
    await listen(apiServer, apiTestPort)
    const apiFixture: ApiTestFixture = { db, config: fixtureConfig, providerInitCalls: { count: 0 } }
    testCase.context.apiFixture = apiFixture
    return async () => {
      await close(apiServer!)
      await stopChild(providerProcess)
      await db.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    if (apiServer) await close(apiServer)
    await stopChild(providerProcess)
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

const apiTestPort = Number(process.env.API_TEST_PORT)
const providerTestPort = Number(process.env.PROVIDER_TEST_PORT)
if (!Number.isSafeInteger(apiTestPort) || apiTestPort < 40000 || apiTestPort > 65535 ||
    !Number.isSafeInteger(providerTestPort) || providerTestPort < 40000 || providerTestPort > 65535 || apiTestPort === providerTestPort) {
  throw new Error('API_TEST_PORT and PROVIDER_TEST_PORT must be set to distinct ports between 40000 and 65535 in .env.test')
}
const apiBaseURL = `http://127.0.0.1:${apiTestPort}`

processCLIArgs(process.argv.splice(2))

configure({
  suites: [
    { name: 'unit', files: ['tests/unit/**/*.spec.ts'] },
    {
      name: 'integration',
      files: ['tests/integration/**/*.spec.ts'],
      configure(suite) {
        suite.onTest((testCase) => testCase.setup(setupApiTest))
      },
    },
    { name: 'contract', files: ['tests/contract/**/*.spec.ts'] },
    {
      name: 'e2e',
      files: ['tests/e2e/**/*.spec.ts'],
      configure(suite) { suite.onTest((testCase) => testCase.setup(setupRealProviderE2E)) },
    },
  ],
  plugins: [assert(), apiClient({ baseURL: apiBaseURL })],
})

run()
