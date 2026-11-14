import type { RuntimeConfig } from './model'

export const runtimeKeys = ['API_ORIGIN', 'PROVIDER_ORIGIN', 'DOCS_ORIGIN', 'MAILPIT_ORIGIN'] as const

export function parseBrowserOrigin(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value === '') throw new Error(`${key} must be an absolute browser HTTP(S) origin`)
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`${key} must be an absolute browser HTTP(S) origin`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${key} must contain only an absolute browser HTTP(S) origin`)
  }
  if (['api', 'provider', 'docs', 'frontend', 'queue', 'mailpit'].includes(parsed.hostname)) throw new Error(`${key} must use a host-browser-reachable name, not a Compose service name`)
  return parsed.origin
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Runtime configuration is not a JSON object')
  const config = value as Record<string, unknown>
  return {
    API_ORIGIN: parseBrowserOrigin(config.API_ORIGIN, 'API_ORIGIN'),
    PROVIDER_ORIGIN: parseBrowserOrigin(config.PROVIDER_ORIGIN, 'PROVIDER_ORIGIN'),
    DOCS_ORIGIN: parseBrowserOrigin(config.DOCS_ORIGIN, 'DOCS_ORIGIN'),
    MAILPIT_ORIGIN: parseBrowserOrigin(config.MAILPIT_ORIGIN, 'MAILPIT_ORIGIN'),
  }
}
