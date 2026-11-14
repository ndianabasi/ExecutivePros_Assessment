import type { RuntimeConfig } from './model'

export const runtimeKeys = ['API_ORIGIN', 'PROVIDER_ORIGIN', 'DOCS_ORIGIN', 'MAILPIT_ORIGIN'] as const

/**
 * Validates one browser-facing origin and returns its normalized absolute URL.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 * @param key - Stable idempotency or notification key used to correlate repeated submissions.
 *
 * @returns The validated or normalized value required by the caller.
 */
export function parseBrowserOrigin(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    throw new Error(`${key} must be an absolute browser HTTP(S) origin`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${key} must be an absolute browser HTTP(S) origin`)
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} must contain only an absolute browser HTTP(S) origin`)
  }
  if (['api', 'provider', 'docs', 'frontend', 'queue', 'mailpit'].includes(parsed.hostname)) {
    throw new Error(`${key} must use a host-browser-reachable name, not a Compose service name`)
  }
  return parsed.origin
}

/**
 * Validates the runtime origins required by the frontend before rendering the application.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 *
 * @returns A runtime config object containing validated browser-facing service origins.
 */
export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Runtime configuration is not a JSON object')
  }
  const config = value as Record<string, unknown>
  return {
    API_ORIGIN: parseBrowserOrigin(config.API_ORIGIN, 'API_ORIGIN'),
    PROVIDER_ORIGIN: parseBrowserOrigin(config.PROVIDER_ORIGIN, 'PROVIDER_ORIGIN'),
    DOCS_ORIGIN: parseBrowserOrigin(config.DOCS_ORIGIN, 'DOCS_ORIGIN'),
    MAILPIT_ORIGIN: parseBrowserOrigin(config.MAILPIT_ORIGIN, 'MAILPIT_ORIGIN'),
  }
}
