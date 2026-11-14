import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Validates and normalizes a configured browser-facing service origin.
 *
 * @param {string} key - Environment variable containing the origin.
 * @param {string} fallback - Development origin used when the variable is unset.
 * @returns {string} The normalized HTTP or HTTPS origin.
 * @throws {Error} When the value is not a browser-reachable origin.
 */
function origin(key, fallback) {
  const value = process.env[key] ?? fallback
  const parsed = new URL(value)
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} must be a browser-reachable HTTP(S) origin`)
  }
  if (['api', 'provider', 'docs', 'frontend', 'queue', 'mailpit'].includes(parsed.hostname)) {
    throw new Error(`${key} must not use a Compose-only service name`)
  }
  return parsed.origin
}

const config = {
  API_ORIGIN: origin('API_ORIGIN', 'http://127.0.0.1:18083'),
  PROVIDER_ORIGIN: origin('PROVIDER_ORIGIN', 'http://127.0.0.1:18082'),
  DOCS_ORIGIN: origin('DOCS_ORIGIN', 'http://127.0.0.1:18081'),
  MAILPIT_ORIGIN: origin('MAILPIT_ORIGIN', 'http://127.0.0.1:18025'),
}
await mkdir(resolve('public'), { recursive: true })
await writeFile(resolve('public/config.json'), `${JSON.stringify(config)}\n`, { mode: 0o644 })
