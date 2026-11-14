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

/**
 * Represents a provider request failure and records whether retrying the request is safe.
 */
export class ProviderError extends Error {
  /**
   * function Object() { [native code] }
   *
   * @param message - Safe human-readable message shown to the API caller or demo user.
   * @param transient - Input value used by this operation.
   * @param status - Validated state used to determine the permitted transition.
   */
  constructor(
    message: string,
    public readonly transient: boolean,
    public readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * Provides the ProviderClient implementation used by the api service.
 */
export class ProviderClient {
  /**
   * function Object() { [native code] }
   *
   * @param baseUrl - Fixed service base URL used to construct authenticated outbound requests.
   * @param secret - Configured service credential or webhook secret used at the authentication boundary.
   * @param timeoutMs - Maximum duration allowed for this network operation before it is aborted.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 5000,
  ) {}

  /**
   * Sends an authenticated API request, applies the configured timeout, and decodes the response contract.
   *
   * @param path - Filesystem or URL path used to locate the requested resource.
   * @param init - Input value used by this operation.
   *
   * @returns The parsed upstream response or a typed provider error after bounded request handling.
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      return controller.abort()
    }, this.timeoutMs)
    try {
      const response = await fetch(new URL(path, `${this.baseUrl}/`), {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.secret}`, Accept: 'application/json', ...init.headers },
      })
      if (!response.ok) {
        throw new ProviderError(
          `Provider returned HTTP ${response.status}`,
          response.status >= 500 || response.status === 404 || response.status === 429,
          response.status,
        )
      }
      return (await response.json()) as T
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error
      }
      throw new ProviderError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Provider request timed out'
          : 'Provider request failed',
        true,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Loads the provider failure-scenario catalogue or returns a safe dependency error.
   *
   * @returns The provider failure scenario catalogue, or a safe dependency error.
   */
  async scenarios(): Promise<FailureScenario[]> {
    const body = await this.request<{ data: FailureScenario[] }>('/failure-scenarios')
    if (!Array.isArray(body.data)) {
      throw new ProviderError('Provider returned an invalid failure scenario catalogue', true)
    }
    return body.data
  }

  /**
   * Creates or configures initialise for use by the api service.
   *
   * @param input - Validated request data used to perform the operation.
   *
   * @returns The initialized provider payment and checkout URL returned by the provider.
   */
  async initialise(input: {
    reference: string
    amount: number
    currency: string
    checkout_expires_at: string
    failure_scenario_code?: string
  }): Promise<ProviderPayment> {
    const body = await this.request<{ data: ProviderPayment }>('/payments/initialise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (
      !body.data ||
      body.data.reference !== input.reference ||
      body.data.amount !== input.amount ||
      body.data.currency !== input.currency
    ) {
      throw new ProviderError('Provider initialization response did not match the request', false)
    }
    return body.data
  }

  /**
   * Performs the lookup operation for the api service and returns its result to the caller.
   *
   * @param reference - Payment reference used to correlate local state with provider evidence.
   *
   * @returns The authoritative provider status associated with the payment reference.
   */
  async lookup(reference: string): Promise<ProviderPayment> {
    const body = await this.request<{ data: ProviderPayment }>(`/payments/${encodeURIComponent(reference)}`)
    if (
      !body.data ||
      body.data.reference !== reference ||
      !Number.isSafeInteger(body.data.amount) ||
      body.data.amount <= 0 ||
      typeof body.data.currency !== 'string' ||
      !['pending', 'success', 'failed', 'cancelled'].includes(body.data.status) ||
      typeof body.data.checkout_expires_at !== 'string'
    ) {
      throw new ProviderError('Provider status response did not match the expected payment contract', true)
    }
    return body.data
  }
}
