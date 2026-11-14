import { http, HttpResponse } from 'msw'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { PaymentDetailPage } from '../../src/pages/PaymentDetailPage'
import { SessionProvider, storageKey } from '../../src/session'
import { parseRuntimeConfig } from '../../src/origins'
import { server } from '../support/server'

const config = parseRuntimeConfig({ API_ORIGIN: 'http://api.test', PROVIDER_ORIGIN: 'http://provider.test', DOCS_ORIGIN: 'http://docs.test', MAILPIT_ORIGIN: 'http://mailpit.test' })

describe('payment detail activity', () => {
  beforeEach(() => {
    localStorage.setItem(storageKey, JSON.stringify({ token: 'test-token-0123456789', user: { id: 1, first_name: 'Ada', last_name: 'User', role: 'user' } }))
    server.use(
      http.get('http://api.test/v1/payments/7', () => HttpResponse.json({ data: {
        id: 7, user_id: 1, cart_id: 5, reference: 'pay_reconciled_0001', status: 'success', amount_minor: 250000, currency: 'NGN',
        created_at: '2026-11-14T06:00:00.000Z', failure_scenario_code: 'WEBHOOK_011', cart: { id: 5, items: [] }, fulfillment: null,
        incidents: [{ id: 2, code: 'invalid_webhook_signature', redacted_details: 'A provider webhook failed HMAC authentication; its unverified contents were not applied', created_at: '2026-11-14T06:01:00.000Z', resolved_at: null }],
        reconciliation_attempts: [{ id: 3, attempt_number: 1, outcome: 'provider_success_reconciled', provider_status: 'success', redacted_details: 'Provider status success was verified and applied.', started_at: '2026-11-14T06:02:00.000Z', completed_at: '2026-11-14T06:02:01.000Z' }],
      } })),
      http.get('http://api.test/v1/carts/5', () => HttpResponse.json({ data: { id: 5, user_id: 1, status: 'checked_out', currency: 'NGN', total_minor: 250000, items: [], payments: [] } })),
    )
  })

  it('shows the original incident and provider resolution as timestamped chronological rows', async () => {
    render(<MemoryRouter initialEntries={['/payments/7']}><SessionProvider config={config}><Routes><Route path="/payments/:paymentId" element={<PaymentDetailPage />} /></Routes></SessionProvider></MemoryRouter>)

    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toHaveTextContent('2026')
    expect(rows[1]).toHaveTextContent('Provider Lookup · Attempt 1')
    expect(rows[1]).toHaveTextContent('provider success reconciled')
    expect(rows[1]).toHaveTextContent('verified and applied')
    expect(rows[2]).toHaveTextContent('invalid_webhook_signature')
    expect(rows[2]).toHaveTextContent('failed HMAC authentication')
  })
})
