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
import { EmailQueueClient } from '../src/queue.js'
import { createNotificationOutboxDispatcher } from '../src/notification-outbox.js'
import { PaymentEventHub } from '../src/payment-events.js'
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

async function runServiceScript(serviceDirectory: string, args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['--import=tsx', ...args], { cwd: serviceDirectory, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000) })
    child.once('error', rejectChild)
    child.once('exit', (code) => code === 0 ? resolveChild() : rejectChild(new Error(`Service setup process exited with ${code}: ${stderr.slice(-1000)}`)))
  })
}

async function runCommand(command: string, args: string[]) {
  return new Promise<string>((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-4000) })
    child.stderr?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-4000) })
    child.once('error', rejectCommand)
    child.once('exit', (code) => code === 0 ? resolveCommand(output.trim()) : rejectCommand(new Error(`${command} ${args[0]} failed with ${code}: ${output.slice(-1000)}`)))
  })
}

async function startMailpit(smtpPort: number, httpPort: number) {
  const name = `api-japa-mailpit-${process.pid}`
  await runCommand('docker', ['run', '--detach', '--rm', '--name', name,
    '--publish', `127.0.0.1:${smtpPort}:1025`, '--publish', `127.0.0.1:${httpPort}:8025`,
    '--env', 'MP_DATABASE=/tmp/mailpit.db', '--env', 'MP_ALLOWED_HOSTS=localhost,127.0.0.1',
    '--env', 'MP_SMTP_BIND_ADDR=0.0.0.0:1025', '--env', 'MP_UI_BIND_ADDR=0.0.0.0:8025',
    '--env', 'MP_DISABLE_VERSION_CHECK=true', '--env', 'MP_BLOCK_REMOTE_CSS_AND_FONTS=true',
    '--env', 'MP_ENABLE_CHAOS=false', 'executivepros-mailpit:v1.33.1'])
  return name
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
  let queueServer: Server | undefined
  let apiServer: Server | undefined
  const queue = { requests: [] as Array<{ authorization: string; requestId: string; body: Record<string, unknown> }>, responseStatus: 202 }
  try {
    await db.migrate.latest()
    await db.seed.run()
    await db('users').insert({ id: 3, first_name: 'Other', last_name: 'User', email: 'other.user@example.test', role: 'user', is_active: true })

    const providerApp = express()
    providerApp.use(express.json({ limit: '64kb' }))
    const providerInitCalls = { count: 0 }
    const providerLookups: { status: number; payment?: Record<string, unknown>; delayMs: number; started: boolean } = { status: 404, delayMs: 0, started: false }
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
    providerApp.get('/payments/:reference', async (request, response) => {
      providerLookups.started = true
      if (providerLookups.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, providerLookups.delayMs))
      if (providerLookups.status !== 200 || !providerLookups.payment) return response.sendStatus(providerLookups.status)
      return response.json({ data: { ...providerLookups.payment, reference: request.params.reference } })
    })
    providerServer = createServer(providerApp).listen(providerTestPort, '127.0.0.1')
    const providerUrl = await listen(providerServer, providerTestPort)

    const queueApp = express()
    queueApp.use(express.json({ limit: '64kb' }))
    queueApp.post('/jobs', (request, response) => {
      queue.requests.push({ authorization: request.header('authorization') ?? '', requestId: request.header('x-request-id') ?? '', body: request.body as Record<string, unknown> })
      if (queue.responseStatus === 202) return response.status(202).json({ job_id: `job-${queue.requests.length}`, status: 'queued', request_id: request.header('x-request-id') })
      return response.status(queue.responseStatus).json({ error: { code: 'QUEUE_UNAVAILABLE' } })
    })
    queueServer = createServer(queueApp)
    const queueUrl = await listen(queueServer, queueTestPort)

    const fixtureConfig = loadConfig({
      NODE_ENV: 'test', PORT: '3000', API_DB_PATH: '/data/api.db',
      API_PUBLIC_ORIGIN: 'http://127.0.0.1:18083', FRONTEND_ORIGIN: 'http://127.0.0.1:18080', DOCS_ORIGIN: 'http://127.0.0.1:18081',
      PROVIDER_BASE_URL: providerUrl, PROVIDER_PUBLIC_ORIGIN: 'http://127.0.0.1:18082',
      QUEUE_BASE_URL: queueUrl, PROVIDER_WEBHOOK_SECRET: 'a'.repeat(32),
      PROVIDER_SERVICE_SECRET: 'b'.repeat(32), QUEUE_SERVICE_SECRET: 'c'.repeat(32),
      PROVIDER_TIMEOUT_MS: '1000', PROVIDER_INIT_BACKOFF_MS: '1', SQLITE_LOCK_BACKOFF_MS: '1',
      QUEUE_TIMEOUT_MS: '250', OUTBOX_RETRY_INITIAL_MS: '10', OUTBOX_RETRY_MAX_MS: '1000',
    })
    const dispatcher = createNotificationOutboxDispatcher(db, new EmailQueueClient(queueUrl, fixtureConfig.queueServiceSecret, fixtureConfig.queueTimeoutMs), fixtureConfig)
    const eventHub = new PaymentEventHub()
    const apiApp = createApp({
      db, isReady: () => true,
      frontendOrigin: fixtureConfig.frontendOrigin, docsOrigin: fixtureConfig.docsOrigin,
      provider: new ProviderClient(fixtureConfig.providerBaseUrl, fixtureConfig.providerServiceSecret, fixtureConfig.providerTimeoutMs),
      config: fixtureConfig,
      eventHub,
    })
    apiServer = createServer(apiApp).listen(apiTestPort, '127.0.0.1')
    await listen(apiServer, apiTestPort)
    const apiFixture: ApiTestFixture = { db, config: fixtureConfig, eventHub, providerInitCalls, providerLookups, apiPort: apiTestPort, queue,
      dispatchOutbox: () => dispatcher.dispatchDue() }
    testCase.context.apiFixture = apiFixture
    return async () => {
      await close(apiServer!)
      eventHub.close()
      await dispatcher.close()
      await close(queueServer!)
      await close(providerServer!)
      await db.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    if (apiServer) await close(apiServer)
    if (queueServer) await close(queueServer)
    if (providerServer) await close(providerServer)
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function setupRealProviderE2E(testCase: Test) {
  testCase.timeout(45000)
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
  const queueDirectory = resolve(process.cwd(), '../queue')
  const providerPublicOrigin = `http://127.0.0.1:${providerTestPort}`
  const apiOrigin = `http://127.0.0.1:${apiTestPort}`
  const serviceSecret = 'b'.repeat(32)
  const webhookSecret = 'a'.repeat(32)
  const queueSecret = 'c'.repeat(32)
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
  let queueProcess: ChildProcess | undefined
  let apiServer: Server | undefined
  let dispatcher: ReturnType<typeof createNotificationOutboxDispatcher> | undefined
  const eventHub = new PaymentEventHub()
  let mailpitName: string | undefined
  let providerOutput = ''
  let queueOutput = ''
  try {
    await db.migrate.latest()
    await db.seed.run()
    await db('users').insert({ id: 3, first_name: 'Other', last_name: 'User', email: 'other.user@example.test', role: 'user', is_active: true })

    await runServiceScript(providerDirectory, ['bin/migrate.ts', 'up'], providerEnv)
    await runServiceScript(providerDirectory, ['src/initialize.ts'], providerEnv)
    providerProcess = spawn(process.execPath, ['--import=tsx', 'src/server.ts'], { cwd: providerDirectory, env: providerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    providerProcess.stdout?.on('data', (chunk: Buffer) => { providerOutput = `${providerOutput}${chunk.toString('utf8')}`.slice(-4000) })
    providerProcess.stderr?.on('data', (chunk: Buffer) => { providerOutput = `${providerOutput}${chunk.toString('utf8')}`.slice(-4000) })
    let providerStartError: Error | undefined
    providerProcess.once('error', (error) => { providerStartError = error })

    mailpitName = await startMailpit(smtpTestPort, mailpitTestPort)
    const mailpitOrigin = `http://127.0.0.1:${mailpitTestPort}`
    let mailpitReady = false
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const response = await fetch(`${mailpitOrigin}/readyz`, { signal: AbortSignal.timeout(250) })
        if (response.ok) { mailpitReady = true; break }
      } catch { /* Poll until the disposable Mailpit listener is ready. */ }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    }
    if (!mailpitReady) throw new Error('Disposable Mailpit did not become ready for API e2e')

    const queueEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test', PORT: String(queueTestPort), JOBS_DB_PATH: join(directory, 'jobs.db'),
      QUEUE_SERVICE_SECRET: queueSecret,
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpTestPort), SMTP_FROM: 'notifications@example.test',
      EMAIL_WORKER_CONCURRENCY: '2', EMAIL_MAX_ATTEMPTS: '3', EMAIL_RETRY_INITIAL_MS: '10',
      SMTP_TIMEOUT_MS: '1000', EMAIL_JOB_TIMEOUT_MS: '2000', EMAIL_LEASE_MS: '4000', EMAIL_POLL_MS: '10',
    }
    await runServiceScript(queueDirectory, ['src/initialize-db.ts'], queueEnv)
    queueProcess = spawn(process.execPath, ['--import=tsx', 'src/server.ts'], { cwd: queueDirectory, env: queueEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    queueProcess.stdout?.on('data', (chunk: Buffer) => { queueOutput = `${queueOutput}${chunk.toString('utf8')}`.slice(-4000) })
    queueProcess.stderr?.on('data', (chunk: Buffer) => { queueOutput = `${queueOutput}${chunk.toString('utf8')}`.slice(-4000) })
    let queueStartError: Error | undefined
    queueProcess.once('error', (error) => { queueStartError = error })
    let queueReady = false
    let lastQueueHealth = 'connection refused'
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (queueStartError) throw queueStartError
      if (queueProcess.exitCode !== null) throw new Error(`Test-mode queue exited before readiness (${queueProcess.exitCode}): ${queueOutput.slice(-1000)}`)
      try {
        const response = await fetch(`http://127.0.0.1:${queueTestPort}/health/ready`, { signal: AbortSignal.timeout(250) })
        lastQueueHealth = `HTTP ${response.status}`
        if (response.ok) { queueReady = true; break }
      } catch { /* Poll until the queue server has bound its configured test port. */ }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    }
    if (!queueReady) throw new Error(`Test-mode queue did not become ready (${lastQueueHealth}): ${queueOutput.slice(-1000)}`)

    const fixtureConfig = loadConfig({
      NODE_ENV: 'test', PORT: String(apiTestPort), API_DB_PATH: '/data/api.db',
      API_PUBLIC_ORIGIN: apiOrigin, FRONTEND_ORIGIN: apiOrigin, DOCS_ORIGIN: 'http://127.0.0.1:18081',
      PROVIDER_BASE_URL: providerPublicOrigin, PROVIDER_PUBLIC_ORIGIN: providerPublicOrigin,
      QUEUE_BASE_URL: `http://127.0.0.1:${queueTestPort}`, PROVIDER_WEBHOOK_SECRET: webhookSecret,
      PROVIDER_SERVICE_SECRET: serviceSecret, QUEUE_SERVICE_SECRET: queueSecret,
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
      eventHub,
    })
    dispatcher = createNotificationOutboxDispatcher(db, new EmailQueueClient(fixtureConfig.queueBaseUrl, queueSecret, fixtureConfig.queueTimeoutMs), fixtureConfig)
    apiServer = createServer(apiApp)
    await listen(apiServer, apiTestPort)
    const apiFixture: ApiTestFixture = { db, config: fixtureConfig, eventHub, providerInitCalls: { count: 0 },
      providerLookups: { status: 404, delayMs: 0, started: false }, apiPort: apiTestPort,
      dispatchOutbox: () => dispatcher!.dispatchDue() }
    testCase.context.apiFixture = apiFixture
    return async () => {
      await close(apiServer!)
      eventHub.close()
      await dispatcher?.close()
      await stopChild(providerProcess)
      await stopChild(queueProcess)
      if (mailpitName) await runCommand('docker', ['stop', mailpitName]).catch(() => '')
      await db.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    if (apiServer) await close(apiServer)
    await dispatcher?.close()
    await stopChild(providerProcess)
    await stopChild(queueProcess)
    if (mailpitName) await runCommand('docker', ['stop', mailpitName]).catch(() => '')
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

const apiTestPort = Number(process.env.API_TEST_PORT)
const providerTestPort = Number(process.env.PROVIDER_TEST_PORT)
const queueTestPort = Number(process.env.QUEUE_TEST_PORT)
const smtpTestPort = Number(process.env.SMTP_TEST_PORT)
const mailpitTestPort = Number(process.env.MAILPIT_TEST_PORT)
if (!Number.isSafeInteger(apiTestPort) || apiTestPort < 40000 || apiTestPort > 65535 ||
    !Number.isSafeInteger(providerTestPort) || providerTestPort < 40000 || providerTestPort > 65535 ||
    !Number.isSafeInteger(queueTestPort) || queueTestPort < 40000 || queueTestPort > 65535 ||
    !Number.isSafeInteger(smtpTestPort) || smtpTestPort < 40000 || smtpTestPort > 65535 ||
    !Number.isSafeInteger(mailpitTestPort) || mailpitTestPort < 40000 || mailpitTestPort > 65535 ||
    new Set([apiTestPort, providerTestPort, queueTestPort, smtpTestPort, mailpitTestPort]).size !== 5) {
  throw new Error('API_TEST_PORT, PROVIDER_TEST_PORT, QUEUE_TEST_PORT, SMTP_TEST_PORT, and MAILPIT_TEST_PORT must be distinct ports between 40000 and 65535 in .env.test')
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
    {
      name: 'contract',
      files: ['tests/contract/**/*.spec.ts'],
      configure(suite) { suite.onTest((testCase) => testCase.setup(setupApiTest)) },
    },
    {
      name: 'e2e',
      files: ['tests/e2e/**/*.spec.ts'],
      configure(suite) { suite.onTest((testCase) => testCase.setup(setupRealProviderE2E)) },
    },
  ],
  plugins: [assert(), apiClient({ baseURL: apiBaseURL })],
})

run()
