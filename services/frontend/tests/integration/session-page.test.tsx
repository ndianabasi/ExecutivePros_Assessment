import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { LoginPage } from '../../src/pages/LoginPage'
import { SessionProvider, storageKey } from '../../src/session'
import { parseRuntimeConfig } from '../../src/origins'
import { server } from '../support/server'

const config = parseRuntimeConfig({ API_ORIGIN: 'http://api.test', PROVIDER_ORIGIN: 'http://provider.test', DOCS_ORIGIN: 'http://docs.test', MAILPIT_ORIGIN: 'http://mailpit.test' })

describe('seeded session flow', () => {
  it('lists active seeded roles and persists the API-issued selected identity', async () => {
    server.use(
      http.get('http://api.test/v1/demo/users', () => HttpResponse.json({ data: [{ id: 1, first_name: 'Ada', last_name: 'User', role: 'user' }, { id: 2, first_name: 'Sam', last_name: 'Admin', role: 'admin' }] })),
      http.post('http://api.test/v1/login', async ({ request }) => {
        const body = await request.json() as { user_id: number }
        return HttpResponse.json({ data: { token: 'issued-token-0123456789', user: { id: body.user_id, first_name: 'Sam', last_name: 'Admin', role: 'admin' } } })
      }),
    )
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/login']}><SessionProvider config={config}><Routes><Route path="/login" element={<LoginPage />} /><Route path="/products" element={<p>Storefront loaded</p>} /></Routes></SessionProvider></MemoryRouter>)
    await screen.findByRole('option', { name: 'Sam Admin — admin' })
    await user.selectOptions(screen.getByLabelText('User'), '2')
    await user.click(screen.getByRole('button', { name: 'Select User' }))
    expect(await screen.findByText('Storefront loaded')).toBeInTheDocument()
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toMatchObject({ token: 'issued-token-0123456789', user: { id: 2, role: 'admin' } }))
  })

  it('removes a malformed stored profile before displaying the demo selector', async () => {
    localStorage.setItem(storageKey, '{malformed')
    server.use(http.get('http://api.test/v1/demo/users', () => HttpResponse.json({ data: [{ id: 1, first_name: 'Ada', last_name: 'User', role: 'user' }] })))
    render(<MemoryRouter initialEntries={['/login']}><SessionProvider config={config}><LoginPage /></SessionProvider></MemoryRouter>)
    await screen.findByRole('option', { name: 'Ada User — user' })
    expect(localStorage.getItem(storageKey)).toBeNull()
  })
})
