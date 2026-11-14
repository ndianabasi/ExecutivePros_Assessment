import type { ApiEnvelope, Identity, RuntimeConfig } from './model'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export type ApiOptions = Omit<RequestInit, 'headers' | 'cache'> & { headers?: HeadersInit; public?: boolean; retry401?: boolean; envelope?: boolean }

export function createApiClient(config: RuntimeConfig, getIdentity: () => Identity | null, onUnauthorized: () => void) {
  const active = new Set<AbortController>()
  const abortAll = () => { for (const controller of active) controller.abort(); active.clear() }

  async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const { public: isPublic = false, retry401 = true, envelope = false, ...requestOptions } = options
    const controller = new AbortController()
    active.add(controller)
    const signal = requestOptions.signal
    const abortFromCaller = () => controller.abort()
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    if (signal?.aborted) controller.abort()
    const headers = new Headers(options.headers)
    if (requestOptions.body && !headers.has('content-type')) headers.set('Content-Type', 'application/json')
    const identity = isPublic ? null : getIdentity()
    if (identity) headers.set('Authorization', `Bearer ${identity.token}`)
    try {
      const response = await fetch(new URL(path, `${config.API_ORIGIN}/`), {
        ...requestOptions,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })
      if (response.status === 204) return undefined as T
      const body = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null
      if (response.status === 401 && identity && retry401) { abortAll(); onUnauthorized() }
      if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? 'request_failed', body?.error?.message ?? `API request failed (${response.status})`)
      return (envelope || !body || !('data' in body) ? body : body.data) as T
    } finally {
      active.delete(controller)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return {
    request,
    get: <T>(path: string, options?: ApiOptions) => request<T>(path, options),
    post: <T>(path: string, data?: unknown, options?: ApiOptions) => request<T>(path, { ...options, method: 'POST', ...(data === undefined ? {} : { body: JSON.stringify(data) }) }),
    patch: <T>(path: string, data: unknown, options?: ApiOptions) => request<T>(path, { ...options, method: 'PATCH', body: JSON.stringify(data) }),
    delete: <T>(path: string, options?: ApiOptions) => request<T>(path, { ...options, method: 'DELETE' }),
    abortAll,
  }
}

export function unwrapEnvelope<T>(value: ApiEnvelope<T> | T): T {
  if (typeof value === 'object' && value !== null && 'data' in value) return value.data
  return value as T
}
