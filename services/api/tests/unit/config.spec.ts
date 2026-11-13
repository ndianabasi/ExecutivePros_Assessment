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
