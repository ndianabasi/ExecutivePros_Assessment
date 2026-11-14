import type { ApiEnvelope, Identity, RuntimeConfig } from './model'

/**
 * Represents a structured API failure with its HTTP status, error code, and request correlation ID.
 */
export class ApiError extends Error {
  /**
   * function Object() { [native code] }
   *
   * @param status - Validated state used to determine the permitted transition.
   * @param code - Validated scenario, error, or incident code used to select the associated behavior.
   * @param message - Safe human-readable message shown to the API caller or demo user.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type ApiOptions = Omit<RequestInit, 'headers' | 'cache'> & {
  headers?: HeadersInit
  public?: boolean
  retry401?: boolean
  envelope?: boolean
}

/**
 * Creates the API client with Bearer authentication, no-store reads, and unauthorized handling.
 *
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 * @param getIdentity - Callback that returns the identity currently selected in the documentation UI.
 * @param onUnauthorized - Callback invoked when a protected operation returns an unauthorized response.
 */
export function createApiClient(
  config: RuntimeConfig,
  getIdentity: () => Identity | null,
  onUnauthorized: () => void,
) {
  const active = new Set<AbortController>()
  const abortAll = () => {
    for (const controller of active) {
      controller.abort()
    }
    active.clear()
  }

  /**
   * Sends an authenticated API request, applies the configured timeout, and decodes the response contract.
   *
   * @param path - Filesystem or URL path used to locate the requested resource.
   * @param options - Named operation options or destructured values that configure the behavior.
   *
   * @returns The parsed upstream response or a typed provider error after bounded request handling.
   */
  async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const { public: isPublic = false, retry401 = true, envelope = false, ...requestOptions } = options
    const controller = new AbortController()
    active.add(controller)
    const signal = requestOptions.signal
    const abortFromCaller = () => {
      return controller.abort()
    }
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    if (signal?.aborted) {
      controller.abort()
    }
    const headers = new Headers(options.headers)
    if (requestOptions.body && !headers.has('content-type')) {
      headers.set('Content-Type', 'application/json')
    }
    const identity = isPublic ? null : getIdentity()
    if (identity) {
      headers.set('Authorization', `Bearer ${identity.token}`)
    }
    try {
      const response = await fetch(new URL(path, `${config.API_ORIGIN}/`), {
        ...requestOptions,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })
      if (response.status === 204) {
        return undefined as T
      }
      const body = (await response.json().catch(() => {
        return null
      })) as {
        data?: T
        error?: { code?: string; message?: string }
      } | null
      if (response.status === 401 && identity && retry401) {
        abortAll()
        onUnauthorized()
      }
      if (!response.ok) {
        throw new ApiError(
          response.status,
          body?.error?.code ?? 'request_failed',
          body?.error?.message ?? `API request failed (${response.status})`,
        )
      }
      return (envelope || !body || !('data' in body) ? body : body.data) as T
    } finally {
      active.delete(controller)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return {
    request,
    get: <T>(path: string, options?: ApiOptions) => {
      return request<T>(path, options)
    },
    post: <T>(path: string, data?: unknown, options?: ApiOptions) => {
      return request<T>(path, {
        ...options,
        method: 'POST',
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      })
    },
    patch: <T>(path: string, data: unknown, options?: ApiOptions) => {
      return request<T>(path, { ...options, method: 'PATCH', body: JSON.stringify(data) })
    },
    delete: <T>(path: string, options?: ApiOptions) => {
      return request<T>(path, { ...options, method: 'DELETE' })
    },
    abortAll,
  }
}

/**
 * Extracts the payload from an API envelope while leaving already-unwrapped values unchanged.
 *
 * @param value - API response payload, either wrapped in the shared envelope or returned directly.
 * @returns The unwrapped payload with its original generic type preserved.
 */
export function unwrapEnvelope<T>(value: ApiEnvelope<T> | T): T {
  if (typeof value === 'object' && value !== null && 'data' in value) {
    return value.data
  }
  return value as T
}
