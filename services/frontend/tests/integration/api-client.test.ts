import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/api'
import { parseRuntimeConfig } from '../../src/origins'
import type { Identity } from '../../src/model'
import { server } from '../support/server'

const config = parseRuntimeConfig({ API_ORIGIN: 'http://api.test', PROVIDER_ORIGIN: 'http://provider.test', DOCS_ORIGIN: 'http://docs.test', MAILPIT_ORIGIN: 'http://mailpit.test' })
const identity: Identity = { token: 'integration-token-0123456789', user: { id: 1, first_name: 'Test', last_name: 'User', role: 'user' } }

afterEach(() => vi.unstubAllGlobals())

describe('direct API client contract', () => {
  it('uses no-store, browser-origin URLs, and selected-user Bearer auth', async () => {
    let requestMetadata: { authorization: string | null; origin: string } | null = null
    server.use(http.get('http://api.test/v1/products', ({ request }) => {
      requestMetadata = { authorization: request.headers.get('authorization'), origin: new URL(request.url).origin }
      return HttpResponse.json({ data: [{ id: 4 }], meta: { page: 1, page_size: 20, total: 1 } })
    }))
    const api = createApiClient(config, () => identity, vi.fn())
    const body = await api.get<{ data: Array<{ id: number }>; meta: { total: number } }>('/v1/products', { envelope: true })
    expect(body.data[0]?.id).toBe(4)
    expect(requestMetadata).toEqual({ authorization: `Bearer ${identity.token}`, origin: config.API_ORIGIN })
  })

  it('sets every API-data fetch to no-store', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${config.API_ORIGIN}/v1/fresh`)
      expect(init?.cache).toBe('no-store')
      return new Response(JSON.stringify({ data: { fresh: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const api = createApiClient(config, () => identity, vi.fn())
    await api.get<{ fresh: boolean }>('/v1/fresh')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('clears identity after protected 401 but keeps network errors distinguishable', async () => {
    const unauthorized = vi.fn()
    server.use(http.get('http://api.test/v1/payments', () => HttpResponse.json({ error: { code: 'unauthorized', message: 'expired' } }, { status: 401 })))
    const api = createApiClient(config, () => identity, unauthorized)
    await expect(api.get('/v1/payments')).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(unauthorized).toHaveBeenCalledOnce()
  })
})
