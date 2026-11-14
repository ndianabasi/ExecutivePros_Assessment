import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export interface ApiConfig {
  nodeEnv: string
  port: number
  dbPath: string
  apiPublicOrigin: string
  frontendOrigin: string
  docsOrigin: string
  providerBaseUrl: string
  providerPublicOrigin: string
  queueBaseUrl: string
  providerWebhookSecret: string
  providerServiceSecret: string
  queueServiceSecret: string
  queueTimeoutMs: number
  outboxRetryInitialMs: number
  outboxRetryMaxMs: number
  providerTimeoutMs: number
  providerInitAttempts: number
  providerInitBackoffMs: number
  sqliteLockAttempts: number
  sqliteLockBackoffMs: number
  reconcileIntervalMs: number
  reconcileGraceMs: number
  outboxIntervalMs: number
  jobBatchSize: number
  paymentExpiryDays: number
  sseHeartbeatMs: number
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`Missing required configuration: ${key}`)
  return value
}

function origin(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key)
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value.replace(/\/$/, '')) {
    throw new Error(`${key} must be an absolute HTTP(S) origin without a path`)
  }
  return parsed.origin
}

function serviceUrl(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key)
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${key} must be an absolute HTTP(S) URL`)
  }
  return parsed.toString().replace(/\/$/, '')
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const direct = env[name]?.trim()
  const filePath = env[`${name}_FILE`]?.trim()
  if (direct && filePath) throw new Error(`Configure only ${name} or ${name}_FILE`)
  if (direct && env.NODE_ENV !== 'test') throw new Error(`${name} direct values are allowed only in tests; configure ${name}_FILE`)
  const value = filePath ? readFileSync(filePath, 'utf8').trim() : direct
  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must contain at least 32 bytes`)
  }
  return value
}

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`)
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = required(env, 'NODE_ENV')
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV must be development, test, or production')
  const port = boundedInteger(env, 'PORT', 3000, 1, 65535)

  const dbPath = required(env, 'API_DB_PATH')
  const resolvedDbPath = resolve(dbPath)
  const relativeDbPath = relative('/data', resolvedDbPath)
  if (!isAbsolute(dbPath) || relativeDbPath === '' || relativeDbPath === '..' || relativeDbPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('API_DB_PATH must be inside the mounted /data directory')
  }

  const config: ApiConfig = {
    nodeEnv,
    port,
    dbPath,
    apiPublicOrigin: origin(env, 'API_PUBLIC_ORIGIN'),
    frontendOrigin: origin(env, 'FRONTEND_ORIGIN'),
    docsOrigin: origin(env, 'DOCS_ORIGIN'),
    providerBaseUrl: serviceUrl(env, 'PROVIDER_BASE_URL'),
    providerPublicOrigin: origin(env, 'PROVIDER_PUBLIC_ORIGIN'),
    queueBaseUrl: serviceUrl(env, 'QUEUE_BASE_URL'),
    providerWebhookSecret: secret(env, 'PROVIDER_WEBHOOK_SECRET'),
    providerServiceSecret: secret(env, 'PROVIDER_SERVICE_SECRET'),
    queueServiceSecret: secret(env, 'QUEUE_SERVICE_SECRET'),
    queueTimeoutMs: boundedInteger(env, 'QUEUE_TIMEOUT_MS', 5000, 100, 30000),
    outboxRetryInitialMs: boundedInteger(env, 'OUTBOX_RETRY_INITIAL_MS', 1000, 1, 300000),
    outboxRetryMaxMs: boundedInteger(env, 'OUTBOX_RETRY_MAX_MS', 300000, 1000, 3600000),
    providerTimeoutMs: boundedInteger(env, 'PROVIDER_TIMEOUT_MS', 5000, 100, 30000),
    providerInitAttempts: boundedInteger(env, 'PROVIDER_INIT_ATTEMPTS', 3, 1, 10),
    providerInitBackoffMs: boundedInteger(env, 'PROVIDER_INIT_BACKOFF_MS', 1000, 1, 30000),
    sqliteLockAttempts: boundedInteger(env, 'SQLITE_LOCK_ATTEMPTS', 3, 1, 10),
    sqliteLockBackoffMs: boundedInteger(env, 'SQLITE_LOCK_BACKOFF_MS', 100, 1, 5000),
    reconcileIntervalMs: boundedInteger(env, 'RECONCILE_INTERVAL_MS', 60000, 100, 3600000),
    reconcileGraceMs: boundedInteger(env, 'RECONCILE_GRACE_MS', 30000, 0, 3600000),
    outboxIntervalMs: boundedInteger(env, 'OUTBOX_INTERVAL_MS', 5000, 100, 3600000),
    jobBatchSize: boundedInteger(env, 'JOB_BATCH_SIZE', 100, 1, 1000),
    paymentExpiryDays: boundedInteger(env, 'PAYMENT_EXPIRY_DAYS', 30, 1, 365),
    sseHeartbeatMs: boundedInteger(env, 'SSE_HEARTBEAT_MS', 15000, 50, 120000),
  }
  if (config.outboxRetryInitialMs > config.outboxRetryMaxMs) throw new Error('OUTBOX_RETRY_INITIAL_MS cannot exceed OUTBOX_RETRY_MAX_MS')
  return config
}
