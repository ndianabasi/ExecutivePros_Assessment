import { Link } from 'react-router'
import { usePaymentEvents } from '../events'
import { Button } from './ui/button'
import { Card, CardHeading } from './ui/card'

export function PaymentNotifications() {
  const { notifications, dismissNotification } = usePaymentEvents()
  if (notifications.length === 0) return null

  return <section aria-label="Payment Notifications" aria-live="polite" className="mx-auto mt-4 max-w-6xl px-4">
    <Card className="border-sky-200 bg-white">
      <CardHeading>Payment Notifications ({notifications.length})</CardHeading>
      <ul className="divide-y divide-slate-200">
        {notifications.map((notification) => <li key={notification.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{notification.title}</p>
            <p className="mt-1 text-sm text-slate-700">{notification.message}</p>
            <p className="mt-1 text-xs text-slate-500">{new Date(notification.occurred_at).toLocaleString()}</p>
            <Link className="mt-1 inline-block text-sm font-semibold text-sky-900 underline" to={`/payments/${notification.payment_id}`}>View Payment {notification.reference}</Link>
          </div>
          <Button variant="ghost" className="shrink-0" aria-label={`Dismiss ${notification.title} for ${notification.reference}`} onClick={() => dismissNotification(notification.id)}>Dismiss</Button>
        </li>)}
      </ul>
    </Card>
  </section>
}
