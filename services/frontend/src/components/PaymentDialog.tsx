import * as Dialog from '@radix-ui/react-dialog'
import { ExternalLink, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from './ui/button'

export interface ActivePayment {
  id: number
  reference: string
  url: string
}

/**
 * Determines whether provider url satisfies the condition required by the caller.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 * @param origin - Configured browser or provider origin used to validate a URL boundary.
 *
 * @returns Whether the supplied value satisfies the documented condition.
 */
export function isProviderUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password
    )
  } catch {
    return false
  }
}

/**
 * Renders the provider checkout dialog and validates completion messages before notifying its parent.
 *
 * @param options - Named operation options or destructured values that configure the behavior.
 */
export function PaymentDialog({
  payment,
  providerOrigin,
  onClose,
  onFinished,
}: {
  payment: ActivePayment | null
  providerOrigin: string
  onClose(): void
  onFinished(reference: string): void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (!payment) {
      return
    }
    const listener = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== providerOrigin ||
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== 'object'
      ) {
        return
      }
      const data = event.data as { type?: unknown; reference?: unknown }
      if (data.type !== 'mock-payment.finished' || data.reference !== payment.reference) {
        return
      }
      onFinished(payment.reference)
    }
    window.addEventListener('message', listener)
    return () => {
      return window.removeEventListener('message', listener)
    }
  }, [onFinished, payment, providerOrigin])

  const valid = Boolean(payment && isProviderUrl(payment.url, providerOrigin))
  return (
    <Dialog.Root
      open={Boolean(payment && valid)}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(96vw,760px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white p-4 shadow-2xl focus:outline-none sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-xl font-bold">Complete Payment</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-slate-600">
                Payment status is confirmed by the API after the provider responds.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" aria-label="Close Payment Dialog">
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {valid && payment ? (
            <>
              <iframe
                ref={frame}
                title={`Mock payment checkout ${payment.reference}`}
                src={payment.url}
                className="mt-4 min-h-[55vh] w-full flex-1 rounded-lg border border-slate-200"
                sandbox="allow-forms allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
              />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p role="status" className="text-sm text-slate-600">
                  Reference {payment.reference}
                </p>
                <a
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
                  href={payment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Open in New Tab <ExternalLink size={16} aria-hidden="true" />
                </a>
              </div>
            </>
          ) : (
            <p role="alert" className="mt-6 text-rose-800">
              The provider URL does not match the configured payment origin.
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
