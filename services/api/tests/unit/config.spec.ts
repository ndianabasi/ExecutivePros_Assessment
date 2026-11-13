import { test } from '@japa/runner'
import { loadConfig } from '../../src/config.js'

const validConfig: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  API_DB_PATH: '/data/api.db',
  API_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
  FRONTEND_ORIGIN: 'http://127.0.0.1:8080',
  DOCS_ORIGIN: 'http://127.0.0.1:8081',
  PROVIDER_BASE_URL: 'http://provider:3000',
  PROVIDER_PUBLIC_ORIGIN: 'http://127.0.0.1:8082',
  QUEUE_BASE_URL: 'http://queue:3000',
  PROVIDER_WEBHOOK_SECRET: 'a'.repeat(32),
  PROVIDER_SERVICE_SECRET: 'b'.repeat(32),
  QUEUE_SERVICE_SECRET: 'c'.repeat(32),
}

test('loads an API configuration with explicit origins and secrets', ({ assert }) => {
  const config = loadConfig(validConfig)
  assert.equal(config.port, 3000)
  assert.equal(config.apiPublicOrigin, 'http://127.0.0.1:3000')
  assert.equal(config.dbPath, '/data/api.db')
})

test('rejects a URL with a path when an origin is required', ({ assert }) => {
  assert.throws(() => loadConfig({ ...validConfig, API_PUBLIC_ORIGIN: 'http://api:3000/v1' }))
})

test('rejects secret values supplied both directly and by file', ({ assert }) => {
  assert.throws(() => loadConfig({ ...validConfig, PROVIDER_WEBHOOK_SECRET_FILE: '/secret' }))
})

test('rejects direct secrets outside test mode and database paths escaping the mounted data directory', ({ assert }) => {
  assert.throws(() => loadConfig({ ...validConfig, NODE_ENV: 'production' }))
  assert.throws(() => loadConfig({ ...validConfig, API_DB_PATH: '/data/../etc/api.db' }))
})

test('allows bounded deterministic job settings in tests', ({ assert }) => {
  const config = loadConfig({ ...validConfig, RECONCILE_INTERVAL_MS: '250', JOB_BATCH_SIZE: '5' })
  assert.equal(config.reconcileIntervalMs, 250)
  assert.equal(config.jobBatchSize, 5)
  assert.throws(() => loadConfig({ ...validConfig, JOB_BATCH_SIZE: '0' }))
})
