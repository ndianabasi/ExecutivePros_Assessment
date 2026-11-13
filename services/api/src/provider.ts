export interface FailureScenario {
  code: string
  name: string
  description: string
  category?: string
}

export interface ProviderPayment {
  reference: string
  provider_reference?: string
  amount: number
  currency: string
  status: 'pending' | 'success' | 'failed' | 'cancelled'
  payment_url?: string
  checkout_expires_at: string
}

export class ProviderError extends Error {
  constructor(message: string, public readonly transient: boolean, public readonly status?: number) {
    super(message)
  }
}

export class ProviderClient {
  constructor(private readonly baseUrl: string, private readonly secret: string, private readonly timeoutMs = 5000) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(new URL(path, `${this.baseUrl}/`), {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.secret}`, Accept: 'application/json', ...init.headers },
      })
      if (!response.ok) throw new ProviderError(`Provider returned HTTP ${response.status}`, response.status >= 500 || response.status === 404 || response.status === 429, response.status)
      return await response.json() as T
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(error instanceof Error && error.name === 'AbortError' ? 'Provider request timed out' : 'Provider request failed', true)
    } finally {
      clearTimeout(timeout)
    }
  }

  async scenarios(): Promise<FailureScenario[]> {
    const body = await this.request<{ data: FailureScenario[] }>('/failure-scenarios')
    if (!Array.isArray(body.data)) throw new ProviderError('Provider returned an invalid failure scenario catalogue', true)
    return body.data
  }

  async initialise(input: { reference: string; amount: number; currency: string; checkout_expires_at: string; failure_scenario_code?: string }): Promise<ProviderPayment> {
    const body = await this.request<{ data: ProviderPayment }>('/payments/initialise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!body.data || body.data.reference !== input.reference || body.data.amount !== input.amount || body.data.currency !== input.currency) {
      throw new ProviderError('Provider initialization response did not match the request', false)
    }
    return body.data
  }

  async lookup(reference: string): Promise<ProviderPayment> {
    const body = await this.request<{ data: ProviderPayment }>(`/payments/${encodeURIComponent(reference)}`)
    if (!body.data || body.data.reference !== reference) throw new ProviderError('Provider status response did not match the reference', true)
    return body.data
  }
}
