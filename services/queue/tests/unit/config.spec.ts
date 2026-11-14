import { test } from '@japa/runner'
import { loadConfig } from '../../src/config.js'

const valid = {
  NODE_ENV: 'test', PORT: '3000', JOBS_DB_PATH: '/tmp/jobs.db', QUEUE_SERVICE_SECRET: 's'.repeat(32),
  SMTP_HOST: 'mailpit', SMTP_PORT: '1025', SMTP_FROM: 'notifications@example.test',
}

test('requires a strong service secret and valid timeout ordering', ({ assert }) => {
  assert.throws(() => loadConfig({ ...valid, QUEUE_SERVICE_SECRET: 'short' }), /at least 32 bytes/)
  assert.throws(() => loadConfig({ ...valid, SMTP_TIMEOUT_MS: '20000' }), /SMTP_TIMEOUT_MS < EMAIL_JOB_TIMEOUT_MS < EMAIL_LEASE_MS/)
  assert.throws(() => loadConfig({ ...valid, SMTP_HOST: '' }), /Missing required configuration: SMTP_HOST/)
  assert.throws(() => loadConfig({ ...valid, JOBS_DB_PATH: 'jobs.db' }), /absolute path/)
  assert.equal(loadConfig(valid).workerConcurrency, 2)
})
