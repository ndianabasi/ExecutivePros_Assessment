import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { ApiError, createApiClient } from './api'
import type { DemoUser, Identity, RuntimeConfig } from './model'

const storageKey = 'executivepros.frontend.identity.v1'
const checkoutKey = 'executivepros.frontend.checkout.v1'

/**
 * Loads and validates the locally stored demo identity, removing malformed credentials.
 *
 * @returns The requested value or matching records from the configured service source.
 */
function readIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      localStorage.removeItem(storageKey)
      return null
    }
    const row = parsed as Record<string, unknown>
    const user = row.user as Record<string, unknown> | undefined
    if (
      typeof row.token !== 'string' ||
      row.token.length < 16 ||
      !user ||
      !Number.isSafeInteger(user.id) ||
      typeof user.first_name !== 'string' ||
      typeof user.last_name !== 'string' ||
      !['user', 'admin'].includes(String(user.role))
    ) {
      localStorage.removeItem(storageKey)
      return null
    }
    return { token: row.token, user: user as unknown as DemoUser }
  } catch {
    localStorage.removeItem(storageKey)
    return null
  }
}

interface SessionContextValue {
  config: RuntimeConfig
  identity: Identity | null
  api: ReturnType<typeof createApiClient>
  setLogin(identity: Identity): void
  logout(): Promise<void>
  invalidate(): void
}

const SessionContext = createContext<SessionContextValue | null>(null)

/**
 * Provides the selected demo identity, API client, login, logout, and invalidation actions.
 *
 * @param options - Named operation options or destructured values that configure the behavior.
 */
export function SessionProvider({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(() => {
    return readIdentity()
  })
  const invalidate = useCallback(() => {
    localStorage.removeItem(storageKey)
    localStorage.removeItem(checkoutKey)
    setIdentity(null)
  }, [])
  const api = useMemo(() => {
    return createApiClient(
      config,
      () => {
        return identity
      },
      invalidate,
    )
  }, [config, identity, invalidate])
  const setLogin = useCallback((next: Identity) => {
    localStorage.setItem(storageKey, JSON.stringify(next))
    setIdentity(next)
  }, [])
  const logout = useCallback(async () => {
    if (identity) {
      await api.post('/v1/logout', undefined, { retry401: false }).catch(() => {
        return undefined
      })
    }
    api.abortAll()
    invalidate()
  }, [api, identity, invalidate])
  const value = useMemo(() => {
    return { config, identity, api, setLogin, logout, invalidate }
  }, [config, identity, api, setLogin, logout, invalidate])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/**
 * Returns the session context required by authenticated frontend components.
 */
export function useSession() {
  const value = useContext(SessionContext)
  if (!value) {
    throw new Error('useSession must be used inside SessionProvider')
  }
  return value
}

/**
 * Determines whether unauthorized satisfies the condition required by the caller.
 *
 * @param error - Caught exception or dependency failure used to select safe error handling and retry behavior.
 *
 * @returns Whether the supplied value satisfies the documented condition.
 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

export { checkoutKey, storageKey }
