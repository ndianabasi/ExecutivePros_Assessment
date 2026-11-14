import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PaymentEvent } from './model'
import { useSession } from './session'

type Connection = 'connecting' | 'connected' | 'disconnected' | 'stopped'
interface EventContextValue {
  connection: Connection
  event: PaymentEvent | null
  disconnect(): void
  reconnect(): void
}
const EventContext = createContext<EventContextValue | null>(null)

export function PaymentEventProvider({ children }: { children: ReactNode }) {
  const { config, identity, invalidate } = useSession()
  const [connection, setConnection] = useState<Connection>('stopped')
  const [event, setEvent] = useState<PaymentEvent | null>(null)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    setEvent(null)
    if (identity) setPaused(false)
  }, [identity?.token])

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
            cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
          })
          if (response.status === 401) { invalidate(); return }
          if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`)
          attempts = 0
          setConnection('connected')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let eventName = ''
          while (live) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim()
              if (line.startsWith('data:') && eventName === 'payment') {
                try {
                  const next = JSON.parse(line.slice(5).trim()) as PaymentEvent
                  if (Number.isSafeInteger(next.payment_id) && typeof next.reference === 'string') setEvent(next)
                } catch { /* Ignore malformed stream events; a fresh payment read is authoritative. */ }
              }
              if (line === '') eventName = ''
            }
          }
          await reader.cancel().catch(() => undefined)
        } catch {
          if (!live || controller.signal.aborted) return
          setConnection('disconnected')
          attempts = Math.min(attempts + 1, 6)
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempts - 1), 30000)))
        }
      }
    }
    void run()
    return () => { live = false; controller?.abort() }
  }, [config.API_ORIGIN, identity?.token, invalidate, paused])

  const value = useMemo(() => ({ connection, event, disconnect: () => setPaused(true), reconnect: () => setPaused(false) }), [connection, event])
  return <EventContext.Provider value={value}>{children}</EventContext.Provider>
}

export function usePaymentEvents() {
  const value = useContext(EventContext)
  if (!value) throw new Error('usePaymentEvents must be used inside PaymentEventProvider')
  return value
}
