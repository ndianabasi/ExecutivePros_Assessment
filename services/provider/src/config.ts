import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export interface ProviderConfig {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  dbPath: string
  providerPublicOrigin: string
  frontendOrigin: string
  apiWebhookUrl: string
  serviceSecret: string
  webhookSecret: string
  maxCheckoutDays: number
  webhookCopies: number
  initDelayMs: number
  webhookDelayMs: number
  copyIntervalMs: number
  workerConcurrency: number
  maxAttempts: number
  retryInitialMs: number
  httpTimeoutMs: number
  jobTimeoutMs: number
  leaseMs: number
  pollMs: number
  sweepIntervalMs: number
  shutdownGraceMs: number
  sqliteLockAttempts: number
  sqliteLockBackoffMs: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required configuration: ${name}`)
  return value
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function origin(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value.replace(/\/$/, '')) {
    throw new Error(`${name} must be an absolute HTTP(S) origin without a path`)
  }
  return parsed.origin
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const direct = env[name]?.trim()
  const file = env[`${name}_FILE`]?.trim()
  if (direct && file) throw new Error(`Configure only ${name} or ${name}_FILE`)
  if (direct && env.NODE_ENV !== 'test') throw new Error(`${name} direct values are allowed only in tests; configure ${name}_FILE`)
  const value = file ? readFileSync(file, 'utf8').trim() : direct
  if (!value || Buffer.byteLength(value, 'utf8') < 32) throw new Error(`${name} must contain at least 32 bytes`)
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const nodeEnv = required(env, 'NODE_ENV')
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV must be development, test, or production')
  const dbPath = required(env, 'PROVIDER_DB_PATH')
  if (!isAbsolute(dbPath)) throw new Error('PROVIDER_DB_PATH must be absolute')
  const relativePath = relative('/data', resolve(dbPath))
  if (nodeEnv === 'production' && (relativePath === '' || relativePath === '..' || relativePath.startsWith('../'))) {
    throw new Error('PROVIDER_DB_PATH must be inside the mounted /data directory')
  }
  const apiWebhookUrl = required(env, 'API_WEBHOOK_URL')
  const webhook = new URL(apiWebhookUrl)
  if (!['http:', 'https:'].includes(webhook.protocol) || webhook.pathname !== '/v1/webhooks/payment' || webhook.search || webhook.hash || webhook.username || webhook.password) {
    throw new Error('API_WEBHOOK_URL must be the fixed /v1/webhooks/payment HTTP(S) endpoint')
  }
  if (nodeEnv === 'production' && webhook.hostname !== 'api') throw new Error('Production API_WEBHOOK_URL must use the internal api Compose hostname')
  const config: ProviderConfig = {
    nodeEnv: nodeEnv as ProviderConfig['nodeEnv'],
    port: integer(env, 'PORT', 3000, 1, 65535),
    dbPath,
    providerPublicOrigin: origin(env, 'PROVIDER_PUBLIC_ORIGIN'),
    frontendOrigin: origin(env, 'FRONTEND_ORIGIN'),
    apiWebhookUrl: webhook.toString(),
    serviceSecret: secret(env, 'PROVIDER_SERVICE_SECRET'),
    webhookSecret: secret(env, 'PROVIDER_WEBHOOK_SECRET'),
    maxCheckoutDays: integer(env, 'PROVIDER_MAX_CHECKOUT_DAYS', 30, 1, 30),
    webhookCopies: integer(env, 'WEBHOOK_MAX_COPIES', 3, 1, 3),
    initDelayMs: integer(env, 'PROVIDER_INIT_DELAY_MS', 30000, 1, 60000),
    webhookDelayMs: integer(env, 'WEBHOOK_DELAY_MS', 15000, 1, 60000),
    copyIntervalMs: integer(env, 'WEBHOOK_COPY_INTERVAL_MS', 1000, 1, 60000),
    workerConcurrency: integer(env, 'PROVIDER_WORKER_CONCURRENCY', 2, 1, 8),
    maxAttempts: integer(env, 'WEBHOOK_MAX_ATTEMPTS', 5, 1, 10),
    retryInitialMs: integer(env, 'WEBHOOK_RETRY_INITIAL_MS', 2000, 1, 3600000),
    httpTimeoutMs: integer(env, 'WEBHOOK_HTTP_TIMEOUT_MS', 5000, 100, 60000),
    jobTimeoutMs: integer(env, 'WEBHOOK_JOB_TIMEOUT_MS', 10000, 100, 120000),
    leaseMs: integer(env, 'WEBHOOK_LEASE_MS', 15000, 100, 180000),
    pollMs: integer(env, 'WEBHOOK_POLL_MS', 250, 1, 60000),
    sweepIntervalMs: integer(env, 'WEBHOOK_SWEEP_INTERVAL_MS', 1000, 1, 60000),
    shutdownGraceMs: integer(env, 'SHUTDOWN_GRACE_MS', 25000, 100, 120000),
    sqliteLockAttempts: integer(env, 'SQLITE_LOCK_ATTEMPTS', 3, 1, 10),
    sqliteLockBackoffMs: integer(env, 'SQLITE_LOCK_BACKOFF_MS', 100, 1, 5000),
  }
  if (nodeEnv === 'production' && (!['127.0.0.1', 'localhost'].includes(new URL(config.providerPublicOrigin).hostname) ||
      !['127.0.0.1', 'localhost'].includes(new URL(config.frontendOrigin).hostname))) {
    throw new Error('Production provider and frontend browser origins must be host-loopback reachable')
  }
  if (!(config.httpTimeoutMs < config.jobTimeoutMs && config.jobTimeoutMs < config.leaseMs)) {
    throw new Error('Require WEBHOOK_HTTP_TIMEOUT_MS < WEBHOOK_JOB_TIMEOUT_MS < WEBHOOK_LEASE_MS')
  }
  return config
}
