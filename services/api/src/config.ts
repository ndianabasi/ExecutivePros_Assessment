import { readFileSync } from 'node:fs'

export interface ApiConfig {
  nodeEnv: string
  port: number
  dbPath: string
  apiPublicOrigin: string
  frontendOrigin: string
  docsOrigin: string
  providerBaseUrl: string
  queueBaseUrl: string
  providerWebhookSecret: string
  providerServiceSecret: string
  queueServiceSecret: string
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
  const value = filePath ? readFileSync(filePath, 'utf8').trim() : direct
  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must contain at least 32 bytes`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }

  const dbPath = required(env, 'API_DB_PATH')
  if (!dbPath.startsWith('/data/')) {
    throw new Error('API_DB_PATH must be inside the mounted /data directory')
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port,
    dbPath,
    apiPublicOrigin: origin(env, 'API_PUBLIC_ORIGIN'),
    frontendOrigin: origin(env, 'FRONTEND_ORIGIN'),
    docsOrigin: origin(env, 'DOCS_ORIGIN'),
    providerBaseUrl: serviceUrl(env, 'PROVIDER_BASE_URL'),
    queueBaseUrl: serviceUrl(env, 'QUEUE_BASE_URL'),
    providerWebhookSecret: secret(env, 'PROVIDER_WEBHOOK_SECRET'),
    providerServiceSecret: secret(env, 'PROVIDER_SERVICE_SECRET'),
    queueServiceSecret: secret(env, 'QUEUE_SERVICE_SECRET'),
  }
}
