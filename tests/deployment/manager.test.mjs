import test from 'node:test'
import assert from 'node:assert/strict'
import { runLoggedStep, startAfterMigrations, validateOrigins } from '../../src/deployment/manager.mjs'

function originConfig() {
  const ports = { frontend: '19080', docs: '19081', provider: '19082', api: '19083', mailpit: '19025' }
  const origin = (service) => `http://127.0.0.1:${ports[service]}`
  return {
    services: {
      frontend: {
        ports: [{ published: ports.frontend }],
        environment: { API_ORIGIN: origin('api'), PROVIDER_ORIGIN: origin('provider'), DOCS_ORIGIN: origin('docs'), MAILPIT_ORIGIN: origin('mailpit') },
      },
      docs: { ports: [{ published: ports.docs }], environment: { API_ORIGIN: origin('api') } },
      api: {
        ports: [{ published: ports.api }],
        environment: { API_PUBLIC_ORIGIN: origin('api'), FRONTEND_ORIGIN: origin('frontend'), DOCS_ORIGIN: origin('docs'), PROVIDER_PUBLIC_ORIGIN: origin('provider') },
      },
      provider: {
        ports: [{ published: ports.provider }],
        environment: { PROVIDER_PUBLIC_ORIGIN: origin('provider'), FRONTEND_ORIGIN: origin('frontend') },
      },
      mailpit: { ports: [{ published: ports.mailpit }] },
    },
  }
}

test('validates all browser loopback origins against the published host ports', () => {
  assert.equal(validateOrigins(originConfig()), true)
})

test('rejects a loopback origin that drifts from its published port', () => {
  const config = originConfig()
  config.services.frontend.environment.API_ORIGIN = 'http://127.0.0.1:3000'
  assert.throws(() => validateOrigins(config), /derived from the published api port/)
})

test('logs starting and success for a completed operation and starting and failed for an error', async () => {
  const logs = []
  const logger = { log: (line) => logs.push(line), error: (line) => logs.push(line) }
  assert.equal(await runLoggedStep('Build images', () => 'built', logger), 'built')
  await assert.rejects(runLoggedStep('Start services', () => { throw new Error('injected failure') }, logger), /injected failure/)
  assert.deepEqual(logs, [
    'starting: Build images',
    'success: Build images',
    'starting: Start services',
    'failed: Start services: injected failure',
  ])
})

test('runs all one-shot initialization before regular services start', async () => {
  const calls = []
  const steps = []
  await startAfterMigrations('isolated-demo', '.env.test', (project, args, options) => calls.push({ project, args, options }), (label, action) => { steps.push(label); return action() })
  assert.deepEqual(calls.map(({ args }) => args.at(-1)), ['up', 'up', 'dist/src/initialize.js', 'dist/src/initialize-db.js', '--remove-orphans'])
  assert.deepEqual(calls.map(({ args }) => args[3]), ['api', 'provider', 'provider', 'queue', undefined])
  assert.ok(calls.every(({ project, options }) => project === 'isolated-demo' && options.envFile === '.env.test'))
  assert.deepEqual(steps, ['Run API migrations and seed data', 'Run provider migrations', 'Seed provider scenarios and initialize Workmatic', 'Initialize queue database and Workmatic', 'Start six regular services'])
})

test('a failed one-shot initializer stops the sequence before later initializers and Compose up', async () => {
  const calls = []
  const runCompose = (project, args, options) => {
    calls.push({ project, args, options })
    if (args[3] === 'provider' && args.at(-1) === 'up') throw new Error('injected provider migration failure')
  }
  const steps = []
  await assert.rejects(startAfterMigrations('isolated-demo', '.env.test', runCompose, (label, action) => { steps.push(label); return action() }), /injected provider migration failure/)
  assert.equal(calls.length, 2)
  assert.equal(calls.some(({ args }) => args[0] === 'up'), false)
  assert.deepEqual(steps, ['Run API migrations and seed data', 'Run provider migrations'])
})
