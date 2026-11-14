import '../src/load-test-env.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { apiClient } from '@japa/api-client'
import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'
import type { Test } from '@japa/runner/core'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createQueueRuntime } from '../src/jobs.js'
import '../tests/macros.js'

const queueTestPort = Number(process.env.QUEUE_TEST_PORT)
const smtpTestPort = Number(process.env.SMTP_TEST_PORT)
if (
  !Number.isSafeInteger(queueTestPort) ||
  queueTestPort < 40000 ||
  queueTestPort > 65535 ||
  !Number.isSafeInteger(smtpTestPort) ||
  smtpTestPort < 40000 ||
  smtpTestPort > 65535 ||
  queueTestPort === smtpTestPort
) {
  throw new Error(
    'QUEUE_TEST_PORT and SMTP_TEST_PORT must be distinct ports between 40000 and 65535 in .env.test',
  )
}

/**
 * Closes a listening queue test server and waits for active connections.
 *
 * @param server - HTTP server owned by the test fixture.
 * @returns A promise that resolves after the server is closed.
 */
async function close(server: Server) {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    return server.close((error) => {
      return error ? reject(error) : resolve()
    })
  })
}

/**
 * Provisions the queue integration fixture and registers its cleanup.
 *
 * @param testCase - Japa test context receiving the fixture macro.
 * @returns A promise that resolves after the queue server is ready.
 */
async function setupQueueTest(testCase: Test) {
  const directory = await mkdtemp(join(tmpdir(), 'queue-japa-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: String(queueTestPort),
    JOBS_DB_PATH: join(directory, 'jobs.db'),
    QUEUE_SERVICE_SECRET: 'q'.repeat(32),
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpTestPort),
    SMTP_FROM: 'queue@example.test',
    EMAIL_RETRY_INITIAL_MS: '10',
    SMTP_TIMEOUT_MS: '100',
    EMAIL_JOB_TIMEOUT_MS: '200',
    EMAIL_LEASE_MS: '1000',
    EMAIL_POLL_MS: '10',
  })
  const received: string[] = []
  const behavior = { failuresRemaining: 0, permanentReject: false }
  const runtime = createQueueRuntime(config, {
    sender: {
      async send(job) {
        if (behavior.permanentReject) {
          throw Object.assign(new Error('rejected'), { responseCode: 550 })
        }
        if (behavior.failuresRemaining > 0) {
          behavior.failuresRemaining -= 1
          throw Object.assign(new Error('temporary failure'), { responseCode: 421 })
        }
        received.push(job.to)
      },
      close() {},
    },
  })
  runtime.worker.start()
  const app = createApp({
    config,
    client: runtime.client,
    worker: runtime.worker,
    readiness: {
      isDbWritable: () => {
        return true
      },
    },
  })
  const server = createServer(app)
  try {
    server.listen(queueTestPort, '127.0.0.1')
    await once(server, 'listening')
    testCase.context.queueFixture = { config, runtime, received, behavior }
    return async () => {
      await close(server)
      await runtime.worker.stop()
      runtime.sender.close()
      await runtime.db.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    await close(server)
    await runtime.worker.stop()
    runtime.sender.close()
    await runtime.db.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

processCLIArgs(process.argv.splice(2))
configure({
  suites: [
    { name: 'unit', files: ['tests/unit/**/*.spec.ts'] },
    {
      name: 'integration',
      files: ['tests/integration/**/*.spec.ts'],
      configure(suite) {
        suite.onTest((testCase) => {
          return testCase.setup(setupQueueTest)
        })
      },
    },
    {
      name: 'contract',
      files: ['tests/contract/**/*.spec.ts'],
      configure(suite) {
        suite.onTest((testCase) => {
          return testCase.setup(setupQueueTest)
        })
      },
    },
    { name: 'e2e', files: ['tests/e2e/**/*.spec.ts'] },
  ],
  plugins: [assert(), apiClient({ baseURL: `http://127.0.0.1:${queueTestPort}` })],
})
run()
