import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PaymentActivityNotification, PaymentActivityType, PaymentEvent } from './model'
import { useSession } from './session'

type Connection = 'connecting' | 'connected' | 'disconnected' | 'stopped'
interface EventContextValue {
  connection: Connection
  event: PaymentEvent | null
  notifications: PaymentActivityNotification[]
  dismissNotification(id: string): void
  disconnect(): void
  reconnect(): void
}
const EventContext = createContext<EventContextValue | null>(null)
const activityTypes = new Set<PaymentActivityType>([
  'payment_pending',
  'provider_initialization_started',
  'provider_initialization_succeeded',
  'provider_initialization_retry_scheduled',
  'webhook_received',
  'webhook_verification_succeeded',
  'webhook_verification_failed',
  'webhook_result',
  'reconciliation_started',
  'reconciliation_completed',
  'payment_succeeded',
  'payment_failed',
  'payment_cancelled',
])

/**
 * Builds the local-storage key that isolates payment notifications by seeded user ID.
 *
 * @param userId - Seeded-user identifier used to scope authentication, payments, or stored preferences.
 */
export function notificationStorageKey(userId: number) {
  return `executivepros.frontend.payment-notifications.v1:${userId}`
}

/**
 * Checks that an SSE payload matches the supported payment activity notification shape.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 *
 * @returns True only when the event has a supported type and all required safe display fields.
 */
function isPaymentActivity(value: unknown): value is PaymentActivityNotification {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    activityTypes.has(item.type as PaymentActivityType) &&
    Number.isSafeInteger(item.payment_id) &&
    typeof item.reference === 'string' &&
    typeof item.occurred_at === 'string' &&
    Number.isFinite(Date.parse(item.occurred_at)) &&
    typeof item.title === 'string' &&
    typeof item.message === 'string'
  )
}

/**
 * Loads and validates notifications stored for the currently selected seeded user.
 *
 * @param userId - Seeded-user identifier used to scope authentication, payments, or stored preferences.
 *
 * @returns The requested value or matching records from the configured service source.
 */
function readNotifications(userId: number): PaymentActivityNotification[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(notificationStorageKey(userId)) ?? '[]')
    return Array.isArray(value)
      ? value.filter(isPaymentActivity).sort((left, right) => {
          return right.occurred_at.localeCompare(left.occurred_at)
        })
      : []
  } catch {
    return []
  }
}

/**
 * Persists the selected user notification list while allowing the live UI to work if storage fails.
 *
 * @param userId - Seeded-user identifier used to scope authentication, payments, or stored preferences.
 * @param notifications - Owner-scoped payment notification records to persist or render.
 */
function storeNotifications(userId: number, notifications: PaymentActivityNotification[]) {
  try {
    localStorage.setItem(notificationStorageKey(userId), JSON.stringify(notifications))
  } catch {
    /* Keep the in-memory notification if browser storage is unavailable. */
  }
}

/**
 * Maintains the authenticated SSE connection and per-user notification state for the frontend.
 *
 * @param options - Named operation options or destructured values that configure the behavior.
 */
export function PaymentEventProvider({ children }: { children: ReactNode }) {
  const { config, identity, invalidate } = useSession()
  const [connection, setConnection] = useState<Connection>('stopped')
  const [event, setEvent] = useState<PaymentEvent | null>(null)
  const [notificationState, setNotificationState] = useState(() => {
    return {
      userId: identity?.user.id ?? null,
      items: identity ? readNotifications(identity.user.id) : [],
    }
  })
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    setEvent(null)
    if (identity) {
      setPaused(false)
    }
  }, [identity?.token])

  useEffect(() => {
    const userId = identity?.user.id ?? null
    setNotificationState({ userId, items: userId === null ? [] : readNotifications(userId) })
  }, [identity?.user.id])

  const dismissNotification = useCallback(
    (id: string) => {
      const userId = identity?.user.id
      if (userId === undefined) {
        return
      }
      setNotificationState((current) => {
        const items = (current.userId === userId ? current.items : readNotifications(userId)).filter(
          (item) => {
            return item.id !== id
          },
        )
        storeNotifications(userId, items)
        return { userId, items }
      })
    },
    [identity?.user.id],
  )

  useEffect(() => {
    if (!identity || paused) {
      setConnection('stopped')
      return
    }
    let live = true
    let controller: AbortController | undefined
    let attempts = 0
    const run = async () => {
      while (live) {
        controller = new AbortController()
        try {
          setConnection(attempts === 0 ? 'connecting' : 'disconnected')
          const response = await fetch(new URL('/v1/events', `${config.API_ORIGIN}/`), {
            headers: { Authorization: `Bearer ${identity.token}`, Accept: 'text/event-stream' },
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal,
          })
          if (response.status === 401) {
            invalidate()
            return
          }
          if (!response.ok || !response.body) {
            throw new Error(`Event stream failed (${response.status})`)
          }
          attempts = 0
          setConnection('connected')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let eventName = ''
          while (live) {
            const chunk = await reader.read()
            if (chunk.done) {
              break
            }
            buffer += decoder.decode(chunk.value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim()
              }
              if (line.startsWith('data:') && eventName === 'payment-activity') {
                try {
                  const next = JSON.parse(line.slice(5).trim()) as PaymentEvent
                  if (isPaymentActivity(next)) {
                    setEvent(next)
                    const userId = identity.user.id
                    setNotificationState((current) => {
                      const existing = current.userId === userId ? current.items : readNotifications(userId)
                      if (
                        existing.some((item) => {
                          return item.id === next.id
                        })
                      ) {
                        return { userId, items: existing }
                      }
                      const items = [next, ...existing].sort((left, right) => {
                        return right.occurred_at.localeCompare(left.occurred_at)
                      })
                      storeNotifications(userId, items)
                      return { userId, items }
                    })
                  }
                } catch {
                  /* Ignore malformed stream events; a fresh payment read is authoritative. */
                }
              }
              if (line === '') {
                eventName = ''
              }
            }
          }
          await reader.cancel().catch(() => {
            return undefined
          })
        } catch {
          if (!live || controller.signal.aborted) {
            return
          }
          setConnection('disconnected')
          attempts = Math.min(attempts + 1, 6)
          await new Promise((resolve) => {
            return setTimeout(resolve, Math.min(1000 * 2 ** (attempts - 1), 30000))
          })
        }
      }
    }
    void run()
    return () => {
      live = false
      controller?.abort()
    }
  }, [config.API_ORIGIN, identity?.token, invalidate, paused])

  const notifications =
    identity && notificationState.userId === identity.user.id ? notificationState.items : []
  const value = useMemo(() => {
    return {
      connection,
      event,
      notifications,
      dismissNotification,
      disconnect: () => {
        return setPaused(true)
      },
      reconnect: () => {
        return setPaused(false)
      },
    }
  }, [connection, event, notifications, dismissNotification])
  return <EventContext.Provider value={value}>{children}</EventContext.Provider>
}

/**
 * Returns the live connection state, payment activity notifications, and stream controls.
 */
export function usePaymentEvents() {
  const value = useContext(EventContext)
  if (!value) {
    throw new Error('usePaymentEvents must be used inside PaymentEventProvider')
  }
  return value
}
