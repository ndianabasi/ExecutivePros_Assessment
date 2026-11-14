import { randomUUID } from 'node:crypto'

export type PaymentActivityType =
  | 'payment_pending'
  | 'provider_initialization_started'
  | 'provider_initialization_succeeded'
  | 'provider_initialization_retry_scheduled'
  | 'webhook_received'
  | 'webhook_verification_succeeded'
  | 'webhook_verification_failed'
  | 'webhook_result'
  | 'reconciliation_started'
  | 'reconciliation_completed'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_cancelled'

export interface PaymentActivityEvent {
  id: string
  type: PaymentActivityType
  payment_id: number
  reference: string
  occurred_at: string
  title: string
  message: string
  status?: 'pending' | 'success' | 'failed' | 'cancelled'
  source?: 'webhook' | 'reconciliation' | 'provider_initialization' | 'api'
  attempt_number?: number
  request_id?: string
}

export type PaymentActivityDraft = Omit<PaymentActivityEvent, 'id' | 'occurred_at'> & { occurred_at?: string }

export interface PaymentActivityTarget {
  user_id: number
  payment_id: number
  reference: string
}

interface Subscriber {
  send(event: PaymentActivityEvent): void
  close(): void
}

export class PaymentEventHub {
  private readonly subscribers = new Map<number, Set<Subscriber>>()

  subscribe(userId: number, subscriber: Subscriber): () => void {
    const listeners = this.subscribers.get(userId) ?? new Set<Subscriber>()
    listeners.add(subscriber)
    this.subscribers.set(userId, listeners)
    return () => {
      listeners.delete(subscriber)
      if (listeners.size === 0) this.subscribers.delete(userId)
    }
  }

  publish(userId: number, draft: PaymentActivityDraft): PaymentActivityEvent {
    const event: PaymentActivityEvent = {
      ...draft,
      id: randomUUID(),
      occurred_at: draft.occurred_at ?? new Date().toISOString(),
    }
    for (const subscriber of this.subscribers.get(userId) ?? []) subscriber.send(event)
    return event
  }

  close(): void {
    for (const listeners of this.subscribers.values()) {
      for (const subscriber of listeners) subscriber.close()
    }
    this.subscribers.clear()
  }
}
