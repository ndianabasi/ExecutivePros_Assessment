export type ApiOrigin = string

export type DemoIdentity = {
  token: string
  user: { user_id: number; name: string; role: 'user' | 'admin' }
}

const requiredPaths = [
  '/v1/api_docs.json',
  '/v1/demo/users',
  '/v1/login',
  '/v1/logout',
  '/v1/events',
  '/v1/cart/checkout',
  '/v1/webhooks/payment',
]
const forbiddenClientStatusPaths = [
  '/v1/payments/{payment_id}/status',
  '/v1/payments/{payment_id}/status-update',
]
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])

/**
 * Validates an absolute HTTP(S) API origin and rejects credentials, paths, queries, and fragments.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 *
 * @returns The normalized HTTP(S) origin after rejecting credentials and non-origin URL components.
 */
export function validateApiOrigin(value: unknown): ApiOrigin {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('API_ORIGIN must be an absolute HTTP(S) origin')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('API_ORIGIN must be an absolute HTTP(S) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('API_ORIGIN must contain only an absolute HTTP(S) origin')
  }
  return url.origin
}

/**
 * Walks an OpenAPI value recursively and rejects references that leave the document.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 */
function assertLocalReferences(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertLocalReferences)
    return
  }
  if (typeof value !== 'object' || value === null) {
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && (typeof entry !== 'string' || !entry.startsWith('#/'))) {
      throw new Error('OpenAPI document contains an external reference')
    }
    assertLocalReferences(entry)
  }
}

/**
 * Checks that OpenAPI server entries use the configured API origin.
 *
 * @param servers - OpenAPI server entries that must all resolve to the configured API origin.
 * @param origin - Configured browser or provider origin used to validate a URL boundary.
 */
function assertServers(servers: unknown, origin: ApiOrigin): void {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error('OpenAPI operation has no absolute server URL')
  }
  for (const server of servers) {
    if (
      typeof server !== 'object' ||
      server === null ||
      typeof (server as { url?: unknown }).url !== 'string'
    ) {
      throw new Error('OpenAPI server URL is invalid')
    }
    let url: URL
    try {
      url = new URL((server as { url: string }).url)
    } catch {
      throw new Error('OpenAPI server URL must be absolute')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('OpenAPI server origin does not match configured API_ORIGIN')
    }
  }
}

/**
 * Validates the OpenAPI document shape, required routes, allowed server origin, and client auth boundaries.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 * @param originValue - Untrusted configured origin value that must pass the API origin contract.
 *
 * @returns The validated OpenAPI object after its structure, required paths, servers, and auth boundaries pass.
 */
export function validateOpenApi(value: unknown, originValue: unknown): Record<string, unknown> {
  const origin = validateApiOrigin(originValue)
  if (typeof value !== 'object' || value === null) {
    throw new Error('OpenAPI document must be a JSON object')
  }
  const spec = value as Record<string, unknown>
  if (typeof spec.openapi !== 'string' || !/^3\.\d+\.\d+$/.test(spec.openapi)) {
    throw new Error('OpenAPI 3.x document is required')
  }
  if (
    typeof spec.info !== 'object' ||
    spec.info === null ||
    typeof spec.paths !== 'object' ||
    spec.paths === null ||
    Array.isArray(spec.paths)
  ) {
    throw new Error('OpenAPI document is missing info or paths')
  }
  const paths = spec.paths as Record<string, unknown>
  for (const path of requiredPaths) {
    if (!(path in paths)) {
      throw new Error(`OpenAPI document is missing ${path}`)
    }
  }
  for (const path of forbiddenClientStatusPaths) {
    if (path in paths) {
      throw new Error('OpenAPI must not expose a client payment-status update route')
    }
  }
  const schemes = (
    spec.components as
      | { securitySchemes?: Record<string, { type?: string; scheme?: string; in?: string; name?: string }> }
      | undefined
  )?.securitySchemes
  if (schemes?.bearerAuth?.type !== 'http' || schemes.bearerAuth.scheme?.toLowerCase() !== 'bearer') {
    throw new Error('OpenAPI HTTP Bearer security scheme is required')
  }
  if (
    schemes?.providerWebhookHmac?.type !== 'apiKey' ||
    schemes.providerWebhookHmac.in !== 'header' ||
    schemes.providerWebhookHmac.name !== 'X-Provider-Signature'
  ) {
    throw new Error('OpenAPI provider HMAC security scheme is required')
  }
  const checkout = paths['/v1/cart/checkout'] as {
    post?: { parameters?: Array<{ in?: string; name?: string; required?: boolean }> }
  }
  if (
    !checkout.post?.parameters?.some((parameter) => {
      return parameter.in === 'header' && parameter.name === 'Idempotency-Key' && parameter.required === true
    })
  ) {
    throw new Error('OpenAPI checkout must require the Idempotency-Key header')
  }

  assertLocalReferences(spec)
  const rootServers = spec.servers
  const root = rootServers === undefined ? undefined : rootServers
  for (const [pathName, pathValue] of Object.entries(paths)) {
    if (typeof pathValue !== 'object' || pathValue === null || Array.isArray(pathValue)) {
      continue
    }
    const pathItem = pathValue as Record<string, unknown>
    const pathServers = pathItem.servers ?? root
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method.toLowerCase())) {
        continue
      }
      if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
        continue
      }
      const opServers = (operation as { servers?: unknown }).servers ?? pathServers
      assertServers(opServers, origin)
      if (pathName === '/v1/webhooks/payment' && method.toLowerCase() === 'post') {
        const security = (operation as { security?: Array<Record<string, unknown>> }).security
        if (
          !security?.some((item) => {
            return 'providerWebhookHmac' in item
          }) ||
          security.some((item) => {
            return 'bearerAuth' in item
          })
        ) {
          throw new Error('Webhook must use provider HMAC without Bearer authentication')
        }
      }
    }
  }
  assertServers(root, origin)
  return spec
}

/**
 * Builds the browser-storage key that isolates checkout idempotency data by seeded user ID.
 *
 * @param userId - Seeded-user identifier used to scope authentication, payments, or stored preferences.
 *
 * @returns The browser storage key scoped to the selected seeded user.
 */
export function checkoutStorageKey(userId: number): string {
  return `api-docs.checkout-key.v1:${userId}`
}

/**
 * Determines whether special operation satisfies the condition required by the caller.
 *
 * @param method - HTTP method used to select and describe the API operation.
 * @param pathname - Normalized request path matched against the OpenAPI route template.
 *
 * @returns Whether the supplied value satisfies the documented condition.
 */
export function isSpecialOperation(method: string, pathname: string): boolean {
  const path = pathname.replace(/\/$/, '')
  return (
    (method.toUpperCase() === 'POST' && ['/v1/login', '/v1/logout', '/v1/webhooks/payment'].includes(path)) ||
    (method.toUpperCase() === 'GET' && path === '/v1/events')
  )
}

/**
 * Matches a concrete URL path against an OpenAPI route template with path parameters.
 *
 * @param template - OpenAPI route template used to compare a concrete request path.
 * @param pathname - Normalized request path matched against the OpenAPI route template.
 *
 * @returns True when a concrete request pathname matches the OpenAPI template.
 */
export function pathMatches(template: string, pathname: string): boolean {
  const expression = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^/]+\\\}/g, '[^/]+')
  return new RegExp(`^${expression}/?$`).test(pathname)
}
