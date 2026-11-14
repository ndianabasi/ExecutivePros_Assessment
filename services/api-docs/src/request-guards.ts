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

function requiresBearer(spec: Record<string, unknown> | null, urlValue: string, methodValue?: string): boolean {
  if (!spec) return false
  const url = new URL(urlValue)
  const paths = spec.paths as Record<string, Record<string, { security?: Array<Record<string, unknown>> }>> | undefined
  const pathItem = paths && Object.entries(paths).find(([template]) => pathMatches(template, url.pathname))?.[1]
  const operations = methodValue ? [pathItem?.[methodValue.toLowerCase()]] : Object.values(pathItem ?? {})
  return operations.some(operation => operation?.security?.some(scheme => 'bearerAuth' in scheme) ?? false)
}

export function createRequestInterceptor(deps: Pick<GuardDependencies, 'origin' | 'spec' | 'identity'>) {
  return (request: RequestShape): RequestShape => {
    const target = new URL(request.url)
    if (target.origin !== deps.origin) throw new Error('Blocked request outside the configured API origin')
    if (isSpecialOperation(request.method, target.pathname)) throw new Error('This operation is reserved for the API or provider service.')
    if (requiresBearer(deps.spec(), request.url, request.method)) {
      const identity = deps.identity()
      if (!identity) throw new Error('Select a seeded user before running this protected operation.')
      request.headers.Authorization = `Bearer ${identity.token}`
    } else delete request.headers.Authorization
    return request
  }
}

export function createResponseInterceptor(deps: Pick<GuardDependencies, 'spec' | 'onUnauthorized'>) {
  return (response: ResponseShape): ResponseShape => {
    if (response.status === 401 && response.url && requiresBearer(deps.spec(), response.url, response.method)) deps.onUnauthorized()
    return response
  }
}
