import { isSpecialOperation, pathMatches } from './contracts.js'
import type { DemoIdentity } from './contracts.js'

type RequestShape = { url: string; method: string; headers: Record<string, string> }
type ResponseShape = { status?: number; url?: string; method?: string }
type GuardDependencies = {
  origin: string
  spec: () => Record<string, unknown> | null
  identity: () => DemoIdentity | null
  onUnauthorized: () => void
}

/**
 * Determines whether an OpenAPI operation requires a bearer token before it is sent.
 *
 * @param spec - Validated OpenAPI document used to check operation security and local references.
 * @param urlValue - Request URL whose origin and pathname are checked against the API specification.
 * @param methodValue - HTTP method used to select the matching OpenAPI operation.
 *
 * @returns True when the matching OpenAPI operation declares bearer authentication.
 */
function requiresBearer(
  spec: Record<string, unknown> | null,
  urlValue: string,
  methodValue?: string,
): boolean {
  if (!spec) {
    return false
  }
  const url = new URL(urlValue)
  const paths = spec.paths as
    Record<string, Record<string, { security?: Array<Record<string, unknown>> }>> | undefined
  const pathItem =
    paths &&
    Object.entries(paths).find(([template]) => {
      return pathMatches(template, url.pathname)
    })?.[1]
  const operations = methodValue ? [pathItem?.[methodValue.toLowerCase()]] : Object.values(pathItem ?? {})
  return operations.some((operation) => {
    return (
      operation?.security?.some((scheme) => {
        return 'bearerAuth' in scheme
      }) ?? false
    )
  })
}

/**
 * Builds request guards for API origin checks, authorization, and demo credentials.
 *
 * @param deps - Injected origin, OpenAPI document, identity, and response callbacks used by the request guard.
 */
export function createRequestInterceptor(deps: Pick<GuardDependencies, 'origin' | 'spec' | 'identity'>) {
  return (request: RequestShape): RequestShape => {
    const target = new URL(request.url)
    if (target.origin !== deps.origin) {
      throw new Error('Blocked request outside the configured API origin')
    }
    if (isSpecialOperation(request.method, target.pathname)) {
      throw new Error('This operation is reserved for the API or provider service.')
    }
    if (requiresBearer(deps.spec(), request.url, request.method)) {
      const identity = deps.identity()
      if (!identity) {
        throw new Error('Select a seeded user before running this protected operation.')
      }
      request.headers.Authorization = `Bearer ${identity.token}`
    } else {
      delete request.headers.Authorization
    }
    return request
  }
}

/**
 * Builds the response guard that clears a demo identity after an unauthorized response.
 *
 * @param deps - Injected origin, OpenAPI document, identity, and response callbacks used by the request guard.
 */
export function createResponseInterceptor(deps: Pick<GuardDependencies, 'spec' | 'onUnauthorized'>) {
  return (response: ResponseShape): ResponseShape => {
    if (
      response.status === 401 &&
      response.url &&
      requiresBearer(deps.spec(), response.url, response.method)
    ) {
      deps.onUnauthorized()
    }
    return response
  }
}
