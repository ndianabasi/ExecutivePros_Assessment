import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export interface QueueConfig {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  jobsDbPath: string
  serviceSecret: string
  smtpHost: string
  smtpPort: number
  smtpFrom: string
  workerConcurrency: number
  maxAttempts: number
  retryInitialMs: number
  smtpTimeoutMs: number
  jobTimeoutMs: number
  leaseMs: number
  pollMs: number
  shutdownGraceMs: number
}

/**
 * Returns a required environment value or raises a configuration error when it is absent.
 *
 * @param env - Environment variables used to load and validate service configuration.
 * @param key - Stable idempotency or notification key used to correlate repeated submissions.
 *
 * @returns A non-empty required configuration value or a descriptive configuration error.
 */
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required configuration: ${key}`)
  }
  return value
}

/**
 * Parses and bounds an integer environment setting before the service uses it.
 *
 * @param env - Environment variables used to load and validate service configuration.
 * @param key - Stable idempotency or notification key used to correlate repeated submissions.
 * @param fallback - Default value used when the optional environment setting is absent.
 * @param min - Inclusive minimum allowed for the parsed configuration value.
 * @param max - Inclusive maximum allowed for the parsed configuration value.
 *
 * @returns A validated bounded integer configuration value.
 */
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * Loads a required secret from its environment variable or mounted secret file.
 *
 * @param env - Environment variables used to load and validate service configuration.
 *
 * @returns A sufficiently strong configured secret or a descriptive configuration error.
 */
function secret(env: NodeJS.ProcessEnv): string {
  const direct = env.QUEUE_SERVICE_SECRET?.trim()
  const path = env.QUEUE_SERVICE_SECRET_FILE?.trim()
  if (direct && path) {
    throw new Error('Configure only QUEUE_SERVICE_SECRET or QUEUE_SERVICE_SECRET_FILE')
  }
  if (direct && env.NODE_ENV !== 'test') {
    throw new Error(
      'QUEUE_SERVICE_SECRET direct values are allowed only in tests; configure QUEUE_SERVICE_SECRET_FILE',
    )
  }
  const value = path ? readFileSync(path, 'utf8').trim() : direct
  if (!value || Buffer.byteLength(value) < 32) {
    throw new Error('QUEUE_SERVICE_SECRET must contain at least 32 bytes')
  }
  return value
}

/**
 * Loads and validates service environment values, including explicit defaults and bounds.
 *
 * @param env - Environment variables used to load and validate service configuration.
 *
 * @returns The requested value or matching records from the configured service source.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const nodeEnv = required(env, 'NODE_ENV')
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production')
  }
  const jobsDbPath = required(env, 'JOBS_DB_PATH')
  if (!isAbsolute(jobsDbPath)) {
    throw new Error('JOBS_DB_PATH must be an absolute path')
  }
  const resolvedPath = resolve(jobsDbPath)
  const relativePath = relative('/data', resolvedPath)
  if (
    nodeEnv === 'production' &&
    (relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  ) {
    throw new Error('JOBS_DB_PATH must be inside the mounted /data directory')
  }
  const smtpFrom = required(env, 'SMTP_FROM')
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(smtpFrom)) {
    throw new Error('SMTP_FROM must be a valid email address')
  }
  const config: QueueConfig = {
    nodeEnv: nodeEnv as QueueConfig['nodeEnv'],
    port: integer(env, 'PORT', 3000, 1, 65535),
    jobsDbPath,
    serviceSecret: secret(env),
    smtpHost: required(env, 'SMTP_HOST'),
    smtpPort: integer(env, 'SMTP_PORT', 1025, 1, 65535),
    smtpFrom,
    workerConcurrency: integer(env, 'EMAIL_WORKER_CONCURRENCY', 2, 1, 16),
    maxAttempts: integer(env, 'EMAIL_MAX_ATTEMPTS', 3, 1, 10),
    retryInitialMs: integer(env, 'EMAIL_RETRY_INITIAL_MS', 5000, 1, 3600000),
    smtpTimeoutMs: integer(env, 'SMTP_TIMEOUT_MS', 10000, 100, 60000),
    jobTimeoutMs: integer(env, 'EMAIL_JOB_TIMEOUT_MS', 20000, 100, 120000),
    leaseMs: integer(env, 'EMAIL_LEASE_MS', 30000, 100, 180000),
    pollMs: integer(env, 'EMAIL_POLL_MS', 1000, 1, 60000),
    shutdownGraceMs: integer(env, 'SHUTDOWN_GRACE_MS', 25000, 100, 120000),
  }
  if (!(config.smtpTimeoutMs < config.jobTimeoutMs && config.jobTimeoutMs < config.leaseMs)) {
    throw new Error('Require SMTP_TIMEOUT_MS < EMAIL_JOB_TIMEOUT_MS < EMAIL_LEASE_MS')
  }
  return config
}
