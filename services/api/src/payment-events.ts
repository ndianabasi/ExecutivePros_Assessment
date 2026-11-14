export interface PaymentStatusEvent {
  payment_id: number
  reference: string
  status: 'success' | 'failed' | 'cancelled'
  request_id: string
  event_id: string | null
}

interface Subscriber {
  send(event: PaymentStatusEvent): void
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

  publish(userId: number, event: PaymentStatusEvent): void {
    for (const subscriber of this.subscribers.get(userId) ?? []) subscriber.send(event)
  }

  close(): void {
    for (const listeners of this.subscribers.values()) {
      for (const subscriber of listeners) subscriber.close()
    }
    this.subscribers.clear()
  }
}
