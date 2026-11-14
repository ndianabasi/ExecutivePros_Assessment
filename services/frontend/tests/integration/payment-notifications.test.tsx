import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaymentEventProvider, notificationStorageKey } from '../../src/events'
import { PaymentNotifications } from '../../src/components/PaymentNotifications'
import { parseRuntimeConfig } from '../../src/origins'
import { SessionProvider, storageKey } from '../../src/session'

const config = parseRuntimeConfig({ API_ORIGIN: 'http://api.test', PROVIDER_ORIGIN: 'http://provider.test', DOCS_ORIGIN: 'http://docs.test', MAILPIT_ORIGIN: 'http://mailpit.test' })
const identity = { token: 'test-token-0123456789', user: { id: 1, first_name: 'Ada', last_name: 'User', role: 'user' as const } }
const activity = {
  id: 'activity-webhook-verification-0001', type: 'webhook_verification_failed', payment_id: 17,
  reference: 'pay_notification_test_0001', occurred_at: '2026-11-14T07:00:00.000Z',
  title: 'Webhook Verification Failed', message: 'The provider webhook signature could not be verified. No payment data was applied.',
  source: 'webhook',
}

function streamResponse(includeActivity: boolean) {
  const frame = includeActivity
    ? `id: ${activity.id}\nevent: payment-activity\ndata: ${JSON.stringify(activity)}\n\n`
    : ': connected\n\n'
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame)) },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function renderNotifications() {
  return render(<MemoryRouter><SessionProvider config={config}><PaymentEventProvider><PaymentNotifications /></PaymentEventProvider></SessionProvider></MemoryRouter>)
}

describe('persistent payment activity notifications', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps SSE activity visible across remounts until the user dismisses it', async () => {
    localStorage.setItem(storageKey, JSON.stringify(identity))
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(true)))
    const firstRender = renderNotifications()

    expect(await screen.findByText('Webhook Verification Failed')).toBeInTheDocument()
    expect(screen.getByText(activity.message)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: `View Payment ${activity.reference}` })).toHaveAttribute('href', '/payments/17')
    expect(JSON.parse(localStorage.getItem(notificationStorageKey(1)) ?? '[]')).toHaveLength(1)

    firstRender.unmount()
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(false)))
    const secondRender = renderNotifications()
    expect(await screen.findByText('Webhook Verification Failed')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: `Dismiss ${activity.title} for ${activity.reference}` }))
    await waitFor(() => expect(screen.queryByText(activity.title)).not.toBeInTheDocument())
    expect(JSON.parse(localStorage.getItem(notificationStorageKey(1)) ?? '[]')).toEqual([])
    secondRender.unmount()
    renderNotifications()
    await waitFor(() => expect(screen.queryByText(activity.title)).not.toBeInTheDocument())
  })

  it('isolates persisted notifications by selected user', async () => {
    localStorage.setItem(storageKey, JSON.stringify(identity))
    localStorage.setItem(notificationStorageKey(2), JSON.stringify([{ ...activity, id: 'other-user-event', title: 'Other User Payment' }]))
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(false)))
    renderNotifications()
    await waitFor(() => expect(screen.queryByText('Other User Payment')).not.toBeInTheDocument())
  })
})
