import { createHash, randomBytes } from 'node:crypto'
import type { Express } from 'express'
import type { Knex } from 'knex'
import { authenticatedUser } from './auth-middleware.js'
import { HttpError } from './errors.js'
import type { ApiConfig } from './config.js'
import { ProviderClient, ProviderError, type ProviderPayment } from './provider.js'
import { immediate } from './sqlite.js'
import { logger } from './logging.js'
import { checkoutValidator, idempotencyHeaderValidator, validate } from './validation.js'
import type { PaymentEventHub } from './payment-events.js'

type Row = Record<string, unknown>
type CheckoutResult = { paymentId: number; reference: string; created: boolean; alreadyMapped: boolean }

/**
 * Creates a stable checkout fingerprint from the user, cart, and selected provider scenario.
 *
 * @param userId - Seeded-user identifier used to scope authentication, payments, or stored preferences.
 * @param cartId - Owner-scoped cart identifier used to select checkout and item records.
 * @param scenario - Validated provider failure scenario and its immutable payment snapshot.
 *
 * @returns Whether the supplied value satisfies the documented condition.
 */
function canonicalFingerprint(userId: number, cartId: number, scenario: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ user_id: userId, cart_id: cartId, failure_scenario_code: scenario }))
    .digest('hex')
}

/**
 * Maps a stored payment row to the public API response shape without exposing internal fields.
 *
 * @param payment - Stored payment record whose provider state or public response is being handled.
 */
function responseShape(payment: Row) {
  return {
    id: Number(payment.id),
    reference: payment.reference,
    status: payment.status,
    amount_minor: Number(payment.amount_minor),
    currency: payment.currency,
    payment_url: payment.payment_url ?? null,
    failure_scenario_code: payment.failure_scenario_code ?? null,
    created_at: payment.created_at,
  }
}

/**
 * Checks whether a payment status is one of the terminal provider outcomes.
 *
 * @param status - Validated state used to determine the permitted transition.
 *
 * @returns True only for a terminal success, failure, or cancellation status.
 */
function isTerminal(status: unknown): boolean {
  return status === 'success' || status === 'failed' || status === 'cancelled'
}

/**
 * Resolves idempotent checkout to an existing or newly reserved payment attempt.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param args - Validated checkout identity, cart, idempotency key, and provider scenario inputs.
 *
 * @returns The existing idempotent payment mapping or the newly reserved payment attempt.
 */
async function resolveCheckout(
  db: Knex,
  args: {
    userId: number
    key: string
    requestedCartId?: number
    scenario: string | null
  },
): Promise<CheckoutResult> {
  return immediate(db, async (tx) => {
    const prior = (
      await tx.query<{ payment_id: number; cart_id: number; request_fingerprint: string }>(
        'SELECT payment_id, cart_id, request_fingerprint FROM checkout_requests WHERE user_id = :user_id AND idempotency_key = :key',
        { user_id: args.userId, key: args.key },
      )
    )[0]

    if (prior) {
      const fingerprint = canonicalFingerprint(
        args.userId,
        args.requestedCartId ?? Number(prior.cart_id),
        args.scenario,
      )
      if (fingerprint !== prior.request_fingerprint) {
        throw new HttpError(
          409,
          'idempotency_conflict',
          'This Idempotency-Key was already used for a different checkout request',
        )
      }
      const payment = (
        await tx.query<{ id: number; reference: string }>(
          'SELECT id, reference FROM payments WHERE id = :id',
          { id: prior.payment_id },
        )
      )[0]
      if (!payment) {
        throw new Error('Checkout request mapping has no payment')
      }
      return {
        paymentId: Number(payment.id),
        reference: payment.reference,
        created: false,
        alreadyMapped: true,
      }
    }

    let cart: { id: number; status: string; currency: string; user_id: number } | undefined
    if (args.requestedCartId) {
      cart = (
        await tx.query(
          'SELECT id, user_id, status, currency FROM carts WHERE id = :id AND user_id = :user_id',
          { id: args.requestedCartId, user_id: args.userId },
        )
      )[0] as typeof cart
      if (!cart) {
        throw new HttpError(404, 'cart_not_found', 'Cart not found')
      }
    } else {
      cart = (
        await tx.query(
          "SELECT id, user_id, status, currency FROM carts WHERE user_id = :user_id AND status = 'active'",
          { user_id: args.userId },
        )
      )[0] as typeof cart
      if (!cart) {
        const candidates = await tx.query<{ id: number; user_id: number; status: string; currency: string }>(
          `SELECT c.id, c.user_id, c.status, c.currency FROM carts c JOIN payments p ON p.cart_id = c.id
           WHERE c.user_id = :user_id AND c.status = 'checked_out' AND p.status = 'pending'
           GROUP BY c.id ORDER BY c.id`,
          { user_id: args.userId },
        )
        if (candidates.length > 1) {
          throw new HttpError(
            409,
            'cart_selection_required',
            'Select a cart because more than one pending checkout exists',
          )
        }
        cart = candidates[0]
      }
    }
    if (!cart) {
      throw new HttpError(409, 'cart_empty', 'There is no eligible cart to check out')
    }
    if (cart.status === 'paid' || cart.status === 'abandoned') {
      throw new HttpError(409, 'cart_not_checkoutable', 'This cart cannot be checked out')
    }

    const items = await tx.query<{
      product_id: number
      product_name: string
      unit_price_minor: number
      currency: string
      quantity: number
      line_total_minor: number
      is_active: number
      current_name: string
      current_price: number
      current_currency: string
      stock_quantity: number
    }>(
      `SELECT ci.product_id, ci.product_name, ci.unit_price_minor, ci.currency, ci.quantity, ci.line_total_minor,
              p.is_active, p.name AS current_name, p.price_minor AS current_price, p.currency AS current_currency, p.stock_quantity
       FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = :cart_id ORDER BY ci.product_id`,
      { cart_id: cart.id },
    )
    if (items.length === 0) {
      throw new HttpError(409, 'cart_empty', 'Add at least one item before checkout')
    }
    const latest = (
      await tx.query<{
        id: number
        reference: string
        status: string
        amount_minor: number
        currency: string
        failure_scenario_code: string | null
        payment_url: string | null
      }>(
        'SELECT id, reference, status, amount_minor, currency, failure_scenario_code, payment_url FROM payments WHERE cart_id = :cart_id ORDER BY id DESC LIMIT 1',
        { cart_id: cart.id },
      )
    )[0]

    let total = 0
    for (const item of items) {
      if (Number(item.is_active) !== 1) {
        throw new HttpError(409, 'product_unavailable', 'A selected product is no longer available')
      }
      const currentCurrency = cart.status === 'active' ? item.current_currency : item.currency
      const price = cart.status === 'active' ? Number(item.current_price) : Number(item.unit_price_minor)
      if (currentCurrency !== 'NGN' || (total > 0 && currentCurrency !== cart.currency)) {
        throw new HttpError(409, 'currency_mismatch', 'Checkout items must use one supported currency')
      }
      if (!Number.isSafeInteger(price * Number(item.quantity))) {
        throw new HttpError(409, 'amount_overflow', 'Checkout amount exceeds the supported range')
      }
      const reserved = (
        await tx.query<{ quantity: number }>(
          "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM stock_reservations WHERE product_id = :product_id AND status = 'active'",
          { product_id: item.product_id },
        )
      )[0]
      const available = Number(item.stock_quantity) - Number(reserved?.quantity ?? 0)
      const cartAlreadyReserved =
        latest?.status === 'pending'
          ? Number(
              (
                await tx.query<{ quantity: number }>(
                  "SELECT COALESCE(quantity, 0) AS quantity FROM stock_reservations WHERE payment_id = :payment_id AND product_id = :product_id AND status = 'active'",
                  { payment_id: latest.id, product_id: item.product_id },
                )
              )[0]?.quantity ?? 0,
            )
          : 0
      if (available + cartAlreadyReserved < Number(item.quantity)) {
        throw new HttpError(409, 'stock_unavailable', 'A requested quantity is no longer available')
      }
      const line = price * Number(item.quantity)
      total += line
      if (!Number.isSafeInteger(total)) {
        throw new HttpError(409, 'amount_overflow', 'Checkout amount exceeds the supported range')
      }
      if (cart.status === 'active') {
        await tx.query(
          'UPDATE cart_items SET product_name = :name, unit_price_minor = :price, currency = :currency, line_total_minor = :line WHERE cart_id = :cart_id AND product_id = :product_id',
          {
            name: item.current_name,
            price,
            currency: currentCurrency,
            line,
            cart_id: cart.id,
            product_id: item.product_id,
          },
        )
      }
    }
    if (!Number.isSafeInteger(total) || total <= 0) {
      throw new HttpError(409, 'invalid_checkout_total', 'Checkout total must be a positive safe integer')
    }

    if (latest?.status === 'success' || cart.status === 'paid') {
      throw new HttpError(409, 'cart_already_paid', 'A paid cart cannot be checked out again')
    }
    if (latest?.status === 'pending') {
      if (
        latest.failure_scenario_code !== args.scenario ||
        Number(latest.amount_minor) !== total ||
        latest.currency !== cart.currency
      ) {
        throw new HttpError(
          409,
          'pending_payment_conflict',
          'This cart already has a pending payment with different checkout details',
        )
      }
      const fingerprint = canonicalFingerprint(args.userId, Number(cart.id), args.scenario)
      await tx.query(
        'INSERT INTO checkout_requests(user_id, idempotency_key, request_fingerprint, cart_id, payment_id) VALUES (:user_id, :key, :fingerprint, :cart_id, :payment_id)',
        {
          user_id: args.userId,
          key: args.key,
          fingerprint,
          cart_id: cart.id,
          payment_id: latest.id,
        },
      )
      return {
        paymentId: Number(latest.id),
        reference: String(latest.reference),
        created: false,
        alreadyMapped: false,
      }
    }

    if (cart.status === 'checked_out' && (!latest || !['failed', 'cancelled'].includes(latest.status))) {
      throw new HttpError(
        409,
        'cart_not_retryable',
        'A checked-out cart can be retried only after a failed or cancelled attempt',
      )
    }

    const reference = `pay_${randomBytes(18).toString('base64url')}`
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const payment = (
      await tx.query<{ id: number }>(
        `INSERT INTO payments(user_id, cart_id, reference, status, amount_minor, currency, initialisation_state,
         initialisation_attempts, failure_scenario_code, checkout_expires_at, reconcile_after)
       VALUES (:user_id, :cart_id, :reference, 'pending', :amount, :currency, 'pending', 0, :scenario, :expires_at, :reconcile_after)
       RETURNING id`,
        {
          user_id: args.userId,
          cart_id: cart.id,
          reference,
          amount: total,
          currency: cart.currency,
          scenario: args.scenario,
          expires_at: expiresAt,
          reconcile_after: new Date(now.getTime() + 30000).toISOString(),
        },
      )
    )[0]
    if (!payment) {
      throw new Error('Payment insert returned no identifier')
    }

    for (const item of items) {
      await tx.query(
        `INSERT INTO stock_reservations(payment_id, product_id, quantity, status) VALUES (:payment_id, :product_id, :quantity, 'active')`,
        { payment_id: payment.id, product_id: item.product_id, quantity: item.quantity },
      )
    }
    if (cart.status === 'active') {
      await tx.query(
        "UPDATE carts SET status = 'checked_out', total_minor = :total, currency = :currency, checked_out_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND status = 'active'",
        { total, currency: cart.currency, id: cart.id },
      )
    }
    const fingerprint = canonicalFingerprint(args.userId, Number(cart.id), args.scenario)
    await tx.query(
      'INSERT INTO checkout_requests(user_id, idempotency_key, request_fingerprint, cart_id, payment_id) VALUES (:user_id, :key, :fingerprint, :cart_id, :payment_id)',
      {
        user_id: args.userId,
        key: args.key,
        fingerprint,
        cart_id: cart.id,
        payment_id: payment.id,
      },
    )
    return { paymentId: Number(payment.id), reference, created: true, alreadyMapped: false }
  })
}

/**
 * Initializes a reserved API payment with the provider, recording bounded retries and publishing owner activity.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param provider - Authenticated provider client used to initialize payments or look up authoritative status.
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 * @param paymentId - API-owned payment record identifier used to scope the operation.
 * @param reference - Payment reference used to correlate local state with provider evidence.
 * @param providerOrigin - Validated public provider origin used to enforce checkout URL boundaries.
 * @param eventHub - Owner-scoped activity hub used to notify connected payment clients after state changes.
 */
async function initialisePayment(
  db: Knex,
  provider: ProviderClient,
  config: ApiConfig,
  paymentId: number,
  reference: string,
  providerOrigin: string,
  eventHub?: PaymentEventHub,
) {
  const payment = await db('payments').where({ id: paymentId }).first()
  if (!payment || payment.status !== 'pending' || payment.initialisation_state === 'ready') {
    return
  }
  let result: ProviderPayment | undefined
  let permanentFailure: ProviderError | undefined
  for (let attempt = 1; attempt <= config.providerInitAttempts; attempt += 1) {
    await db.raw(
      'UPDATE payments SET initialisation_attempts = :attempt, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND status = :status',
      { attempt, id: paymentId, status: 'pending' },
    )
    eventHub?.publish(Number(payment.user_id), {
      type: 'provider_initialization_started',
      payment_id: paymentId,
      reference,
      title: 'Provider Checkout Initialization Started',
      message: `Provider initialization attempt ${attempt} started.`,
      source: 'provider_initialization',
      attempt_number: attempt,
      status: 'pending',
    })
    try {
      result = await provider.initialise({
        reference,
        amount: Number(payment.amount_minor),
        currency: String(payment.currency),
        checkout_expires_at: String(payment.checkout_expires_at),
        ...(payment.failure_scenario_code
          ? { failure_scenario_code: String(payment.failure_scenario_code) }
          : {}),
      })
      break
    } catch (error) {
      const providerError =
        error instanceof ProviderError ? error : new ProviderError('Provider initialization failed', true)
      if (!providerError.transient) {
        permanentFailure = providerError
        break
      }
      try {
        result = await provider.lookup(reference)
        break
      } catch (lookupError) {
        const canRetry = lookupError instanceof ProviderError && lookupError.transient
        if (!canRetry || attempt === config.providerInitAttempts) {
          break
        }
      }
      if (attempt < config.providerInitAttempts) {
        const base = config.providerInitBackoffMs * 2 ** (attempt - 1)
        await new Promise((resolve) => {
          return setTimeout(resolve, Math.floor(base * (0.75 + Math.random() * 0.5)))
        })
      }
    }
  }

  if (result) {
    const url = result.payment_url ? new URL(result.payment_url) : null
    if (url && url.origin !== providerOrigin) {
      permanentFailure = new ProviderError(
        'Provider returned a payment URL outside the configured origin',
        false,
      )
      logger.error(
        { payment_reference: reference, outcome: 'invalid_provider_url' },
        'provider initialization response rejected',
      )
    } else if (url) {
      const rows = await db.raw<{ id: number }[]>(
        "UPDATE payments SET payment_url = :url, initialisation_state = 'ready', next_initialisation_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND status = 'pending' RETURNING id",
        { url: url.toString(), id: paymentId },
      )
      if (rows.length) {
        eventHub?.publish(Number(payment.user_id), {
          type: 'provider_initialization_succeeded',
          payment_id: paymentId,
          reference,
          title: 'Provider Checkout Ready',
          message: 'The payment provider is ready to accept this payment.',
          source: 'provider_initialization',
          status: 'pending',
        })
      }
      return
    }
  }

  if (permanentFailure) {
    const transitioned = await immediate(db, async (tx) => {
      const changed = await tx.query<{ id: number }>(
        "UPDATE payments SET status = 'failed', initialisation_state = 'failed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND status = 'pending' RETURNING id",
        { id: paymentId },
      )
      if (changed.length === 0) {
        return false
      }
      await tx.query(
        "UPDATE stock_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE payment_id = :id AND status = 'active'",
        { id: paymentId },
      )
      return true
    })
    if (transitioned) {
      eventHub?.publish(Number(payment.user_id), {
        type: 'payment_failed',
        payment_id: paymentId,
        reference,
        status: 'failed',
        source: 'provider_initialization',
        title: 'Payment Failed',
        message: 'The provider permanently rejected payment initialization. Reserved stock was released.',
      })
    }
    logger.error(
      {
        payment_reference: reference,
        provider_status: permanentFailure.status ?? null,
        outcome: 'permanent_initialization_failure',
      },
      'provider initialization permanently rejected',
    )
  } else {
    await db.raw(
      "UPDATE payments SET next_initialisation_at = :next, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND status = 'pending'",
      { next: new Date(Date.now() + 60000).toISOString(), id: paymentId },
    )
    eventHub?.publish(Number(payment.user_id), {
      type: 'provider_initialization_retry_scheduled',
      payment_id: paymentId,
      reference,
      status: 'pending',
      source: 'provider_initialization',
      title: 'Provider Initialization Retry Scheduled',
      message:
        'The provider has not confirmed checkout initialization. The API will retry with the same payment reference.',
    })
  }
}

/**
 * Registers failure-scenario discovery and idempotent checkout endpoints.
 *
 * @param app - Express application to which middleware and route handlers are attached.
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param provider - Authenticated provider client used to initialize payments or look up authoritative status.
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 * @param eventHub - Owner-scoped activity hub used to notify connected payment clients after state changes.
 */
export function registerCheckoutRoutes(
  app: Express,
  db: Knex,
  provider: ProviderClient,
  config: ApiConfig,
  eventHub?: PaymentEventHub,
) {
  /**
   * Loads the provider failure-scenario catalogue or returns a safe dependency error.
   */
  async function scenarios() {
    try {
      return await provider.scenarios()
    } catch {
      throw new HttpError(503, 'provider_unavailable', 'Failure scenarios are temporarily unavailable')
    }
  }

  app.get('/v1/failure-scenarios', async (_request, response) => {
    const available = await scenarios()
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: available })
  })

  app.post('/v1/cart/checkout', async (request, response) => {
    const user = authenticatedUser(request)
    const { key } = await validate<{ key: string }>(
      idempotencyHeaderValidator,
      { key: request.header('idempotency-key') ?? '' },
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8 to 128 safe characters',
    )
    const { cart_id: cartId, failure_scenario_code: scenario } = await validate<{
      cart_id?: number
      failure_scenario_code?: string
    }>(
      checkoutValidator,
      request.body ?? {},
      'invalid_checkout_request',
      'Checkout request fields are invalid',
    )
    const available = await scenarios()
    if (
      scenario !== undefined &&
      !available.some((item) => {
        return item.code === scenario
      })
    ) {
      throw new HttpError(422, 'unknown_failure_scenario', 'The selected failure scenario is unavailable')
    }
    const checkout = await resolveCheckout(db, {
      userId: user.userId,
      key,
      ...(cartId === undefined ? {} : { requestedCartId: cartId }),
      scenario: scenario ?? null,
    })
    logger.info(
      {
        payment_reference: checkout.reference,
        checkout_outcome: checkout.created
          ? 'created'
          : checkout.alreadyMapped
            ? 'idempotency_replay'
            : 'pending_attempt_reused',
      },
      'checkout request resolved',
    )
    if (checkout.created) {
      eventHub?.publish(user.userId, {
        type: 'payment_pending',
        payment_id: checkout.paymentId,
        reference: checkout.reference,
        status: 'pending',
        source: 'api',
        title: 'Payment Started',
        message: 'Checkout was accepted. The API is initializing the provider payment.',
      })
    }
    await initialisePayment(
      db,
      provider,
      config,
      checkout.paymentId,
      checkout.reference,
      config.providerPublicOrigin,
      eventHub,
    )
    const payment = await db('payments').where({ id: checkout.paymentId }).first()
    if (!payment) {
      throw new Error('Checkout payment disappeared')
    }
    const body = { data: responseShape(payment) }
    response.setHeader('Cache-Control', 'no-store')
    if (!checkout.created && !checkout.alreadyMapped && payment.payment_url) {
      return response.status(200).json(body)
    }
    if (checkout.alreadyMapped && payment.payment_url) {
      return response.status(200).json(body)
    }
    if (checkout.created && payment.payment_url) {
      return response.status(201).json(body)
    }
    if (isTerminal(payment.status)) {
      return response.status(200).json(body)
    }
    return response.status(202).json(body)
  })
}
