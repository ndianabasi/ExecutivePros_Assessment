import { createHash, randomBytes } from 'node:crypto'
import type { Express, RequestHandler } from 'express'
import type { Knex } from 'knex'
import type { ProviderConfig } from './config.js'
import { ProviderHttpError } from './errors.js'
import { currentRequestId, logger } from './logging.js'
import { immediate } from './sqlite.js'
import { checkoutTokenValidator, initializeValidator, referenceValidator, submitValidator, validate } from './validation.js'

type InitInput = { reference: string; amount: number; currency: 'NGN'; checkout_expires_at: string; failure_scenario_code?: string }
type PaymentRow = {
  id: number; reference: string; provider_reference: string; amount: number; currency: string; status: string;
  checkout_token_hash: string; payment_url: string; checkout_expires_at: string; scenario_code: string | null;
  scenario_snapshot: string | null; completed_at: string | null;
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function equalInput(payment: PaymentRow, input: InitInput) {
  return payment.amount === input.amount && payment.currency === input.currency && payment.checkout_expires_at === input.checkout_expires_at &&
    payment.scenario_code === (input.failure_scenario_code ?? null)
}
function paymentResponse(payment: PaymentRow) {
  return { reference: payment.reference, provider_reference: payment.provider_reference, amount: payment.amount,
    currency: payment.currency, status: payment.status, payment_url: payment.payment_url, checkout_expires_at: payment.checkout_expires_at }
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function htmlPage(payment: PaymentRow, token: string, message = '', announce = false) {
  const scenario = payment.scenario_code
  const status = payment.status === 'pending' && Date.parse(payment.checkout_expires_at) <= Date.now() ? 'expired' : payment.status
  const amount = (payment.amount / 100).toFixed(2)
  const state = message || (status === 'pending' ? 'Choose a simulated payment outcome.' : status === 'expired' ? 'This checkout has expired. Return to the storefront to refresh payment status.' : `Payment ${status}.`)
  const allowPayOnly = scenario === 'WEBHOOK_008'
  const actions = status === 'pending' && !message ? `<form method="post" action="/payments/submit">
    <input type="hidden" name="checkout_token" value="${escapeHtml(token)}">
    <button type="submit" name="outcome" value="success">Pay successfully</button>
    ${allowPayOnly ? '' : '<button type="submit" name="outcome" value="failed">Fail payment</button><button type="submit" name="outcome" value="cancelled">Cancel payment</button>'}
  </form>` : ''
  const explanation = allowPayOnly ? '<p>This scenario records a successful provider payment, then sends a separate conflicting event to demonstrate API integrity handling.</p>' : ''
  const announceAttr = announce ? 'data-parent-message="true"' : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock payment checkout</title><script src="/checkout.js" defer></script></head><body><main ${announceAttr} data-reference="${escapeHtml(payment.reference)}"><h1>Mock payment checkout</h1><p>Reference: <strong>${escapeHtml(payment.reference)}</strong></p><p>Amount: <strong>${amount} ${escapeHtml(payment.currency)}</strong></p><p>Scenario: ${escapeHtml(scenario ?? 'standard')}</p><p role="status">${escapeHtml(state)}</p>${explanation}${actions}<p>If this page is open in a separate tab, return to the storefront and refresh the payment status.</p></main></body></html>`
}

async function existingPayment(db: Knex, reference: string) {
  return (await db.raw('SELECT * FROM payments WHERE reference = :reference', { reference }) as PaymentRow[])[0]
}

async function scenarioByCode(db: Knex, code: string | undefined) {
  if (!code) return undefined
  const row = (await db.raw('SELECT code, name, description, category, config_json FROM failure_scenarios WHERE code = :code AND is_active = 1', { code }) as Array<Record<string, unknown>>)[0]
  if (!row) throw new ProviderHttpError(422, 'unknown_scenario', 'The selected failure scenario is not active')
  return { row, config: JSON.parse(String(row.config_json)) as Record<string, unknown> }
}

async function createWebhookEvent(tx: { query<T extends Record<string, unknown>>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> }, payment: PaymentRow, config: ProviderConfig, scenario: { code: string; config: Record<string, unknown> } | null) {
  const eventId = `evt_${randomBytes(16).toString('hex')}`
  const eventType = `payment.${payment.status}`
  const createdAt = new Date()
  const canonicalBody = JSON.stringify({ event_id: eventId, event_type: eventType, status: payment.status,
    reference: payment.reference, provider_reference: payment.provider_reference, amount: payment.amount,
    currency: payment.currency, occurred_at: createdAt.toISOString() })
  const canonical = JSON.parse(canonicalBody) as Record<string, unknown>
  const eventScenario = scenario?.config ?? {}
  let transmittedBody = canonicalBody
  let signatureMode = 'valid'
  if (typeof eventScenario.mutate_amount === 'number') transmittedBody = JSON.stringify({ ...canonical, amount: payment.amount + eventScenario.mutate_amount })
  if (eventScenario.malformed_json === true) transmittedBody = '{"event_id":'
  if (eventScenario.invalid_signature === true) signatureMode = 'invalid'
  const skip = eventScenario.skip === true
  const dueMs = scenario?.code === 'WEBHOOK_003' ? (config.nodeEnv === 'test' ? config.webhookDelayMs : Number(eventScenario.delay_ms ?? config.webhookDelayMs)) : 0
  const inserted = await tx.query<{ id: number }>(
    `INSERT INTO webhook_events(event_id, payment_id, event_type, status, canonical_body, transmitted_body, transmitted_hash,
       signature_mode, due_at, created_at)
     VALUES (:event_id, :payment_id, :event_type, :status, :canonical, :transmitted, :hash, :signature_mode, :due_at, :created_at) RETURNING id`,
    { event_id: eventId, payment_id: payment.id, event_type: eventType, status: skip ? 'skipped' : 'pending',
      canonical: canonicalBody, transmitted: transmittedBody, hash: sha256(transmittedBody), signature_mode: signatureMode,
      due_at: new Date(createdAt.getTime() + dueMs).toISOString(), created_at: createdAt.toISOString() },
  )
  if (!inserted[0]) throw new Error('Webhook event insert returned no ID')
  if (skip) logger.info({ payment_reference: payment.reference, provider_event_id: eventId, outcome: 'webhook_skipped' }, 'provider webhook scenario skipped delivery')
  return { id: Number(inserted[0].id), eventId }
}

export async function initializePayment(db: Knex, config: ProviderConfig, input: InitInput) {
  const existing = await existingPayment(db, input.reference)
  if (existing) {
    if (!equalInput(existing, input)) throw new ProviderHttpError(409, 'reference_conflict', 'Payment reference was already initialized with different details')
    return { created: false, data: paymentResponse(existing) }
  }
  const expiry = Date.parse(input.checkout_expires_at)
  const now = Date.now()
  if (expiry <= now || expiry > now + config.maxCheckoutDays * 24 * 60 * 60 * 1000) {
    throw new ProviderHttpError(422, 'invalid_checkout_expiry', 'checkout_expires_at must be in the future and within the supported checkout window')
  }
  const scenario = await scenarioByCode(db, input.failure_scenario_code)
  if (scenario?.row.code === 'PROVIDER_002') throw new ProviderHttpError(500, 'provider_initialization_failed', 'Simulated provider initialization failure')
  if (scenario?.row.code === 'PROVIDER_001') {
    const delay = config.nodeEnv === 'test' ? config.initDelayMs : Number(scenario.config.delay_ms ?? config.initDelayMs)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  if (expiry <= now || expiry > now + config.maxCheckoutDays * 24 * 60 * 60 * 1000) {
    throw new ProviderHttpError(422, 'invalid_checkout_expiry', 'checkout_expires_at must be in the future and within the supported checkout window')
  }

  const token = randomBytes(32).toString('base64url')
  const providerReference = `mock_${randomBytes(18).toString('base64url')}`
  const paymentUrl = new URL(`/checkout/${token}`, `${config.providerPublicOrigin}/`).toString()
  const result = await immediate(db, config, async (tx) => {
    const prior = (await tx.query<PaymentRow>('SELECT * FROM payments WHERE reference = :reference', { reference: input.reference }))[0]
    if (prior) {
      if (!equalInput(prior, input)) throw new ProviderHttpError(409, 'reference_conflict', 'Payment reference was already initialized with different details')
      return { created: false, payment: prior }
    }
    const rows = await tx.query<{ id: number }>(
      `INSERT INTO payments(reference, provider_reference, amount, currency, status, checkout_token_hash, payment_url,
         checkout_expires_at, scenario_code, scenario_snapshot)
       VALUES (:reference, :provider_reference, :amount, :currency, 'pending', :token_hash, :payment_url,
         :expires_at, :scenario_code, :scenario_snapshot) RETURNING id`,
      { reference: input.reference, provider_reference: providerReference, amount: input.amount, currency: input.currency,
        token_hash: sha256(token), payment_url: paymentUrl, expires_at: input.checkout_expires_at,
        scenario_code: scenario?.row.code ?? null, scenario_snapshot: scenario ? JSON.stringify({ code: scenario.row.code, config: scenario.config }) : null },
    )
    if (!rows[0]) throw new Error('Provider payment insert returned no ID')
    const payment = (await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = :id', { id: rows[0].id }))[0]
    if (!payment) throw new Error('Provider payment disappeared after creation')
    return { created: true, payment }
  })
  logger.info({ request_id: currentRequestId(), payment_reference: input.reference, provider_reference: result.payment.provider_reference,
    scenario_code: result.payment.scenario_code, outcome: result.created ? 'initialized' : 'initialization_replay' }, 'provider payment initialization resolved')
  return { created: result.created, data: paymentResponse(result.payment) }
}

async function finishPayment(db: Knex, config: ProviderConfig, token: string, outcome: 'success' | 'failed' | 'cancelled') {
  const tokenHash = sha256(token)
  const payment = await db('payments').where({ checkout_token_hash: tokenHash }).first() as PaymentRow | undefined
  if (!payment) throw new ProviderHttpError(404, 'checkout_not_found', 'Checkout capability was not found')
  const snapshot = payment.scenario_snapshot ? JSON.parse(payment.scenario_snapshot) as { code: string; config: Record<string, unknown> } : null
  if (snapshot?.code === 'WEBHOOK_008' && outcome !== 'success') throw new ProviderHttpError(422, 'scenario_pay_only', 'This scenario supports only a successful payment action')
  if (payment.status !== 'pending') {
    if (payment.status !== outcome) throw new ProviderHttpError(409, 'payment_already_completed', 'Payment already has a different terminal outcome')
    return payment
  }
  if (Date.parse(payment.checkout_expires_at) <= Date.now()) throw new ProviderHttpError(410, 'checkout_expired', 'This checkout has expired')
  await immediate(db, config, async (tx) => {
    const changed = await tx.query<{ id: number }>(
      `UPDATE payments SET status = :status, completed_at = :completed, updated_at = :completed
       WHERE id = :id AND status = 'pending' RETURNING id`,
      { status: outcome, completed: new Date().toISOString(), id: payment.id },
    )
    if (changed.length === 0) {
      const current = (await tx.query<{ status: string }>('SELECT status FROM payments WHERE id = :id', { id: payment.id }))[0]
      if (current?.status !== outcome) throw new ProviderHttpError(409, 'payment_already_completed', 'Payment already has a different terminal outcome')
      return
    }
    const transitioned = { ...payment, status: outcome }
    await createWebhookEvent(tx, transitioned, config, snapshot)
  })
  return { ...payment, status: outcome, completed_at: new Date().toISOString() }
}

export function registerPaymentRoutes(app: Express, db: Knex, config: ProviderConfig, dependencies: { schedule: () => Promise<void>; serviceAuth: RequestHandler }) {
  app.post('/payments/initialise', dependencies.serviceAuth, async (request, response) => {
    const input = await validate<InitInput>(initializeValidator, request.body)
    const created = await initializePayment(db, config, input)
    response.setHeader('Cache-Control', 'no-store')
    return response.status(created.created ? 201 : 200).json({ data: created.data })
  })

  app.get('/payments/:reference', dependencies.serviceAuth, async (request, response) => {
    const { reference } = await validate<{ reference: string }>(referenceValidator, request.params)
    const payment = await existingPayment(db, reference)
    if (!payment) throw new ProviderHttpError(404, 'payment_not_found', 'Provider payment was not found')
    response.setHeader('Cache-Control', 'no-store')
    return response.json({ data: paymentResponse(payment) })
  })

  app.get('/failure-scenarios', dependencies.serviceAuth, async (_request, response) => {
    const rows = await db.raw('SELECT code, name, description, category FROM failure_scenarios WHERE is_active = 1 ORDER BY code') as Array<Record<string, unknown>>
    response.setHeader('Cache-Control', 'no-store')
    return response.json({ data: rows })
  })

  app.get('/checkout.js', (_request, response) => {
    response.type('application/javascript').send(`const origin=${JSON.stringify(config.frontendOrigin)};const node=document.querySelector('[data-parent-message]');if(node&&window.parent!==window){window.parent.postMessage({type:'mock-payment.finished',reference:node.dataset.reference},origin)}`)
  })

  app.get('/checkout/:token', async (request, response) => {
    const { token } = await validate<{ token: string }>(checkoutTokenValidator, request.params)
    const payment = await db('payments').where({ checkout_token_hash: sha256(token) }).first() as PaymentRow | undefined
    if (!payment) throw new ProviderHttpError(404, 'checkout_not_found', 'Checkout capability was not found')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    return response.type('html').send(htmlPage(payment, token, '', payment.status !== 'pending'))
  })

  app.post('/payments/submit', async (request, response) => {
    const { checkout_token: token, outcome } = await validate<{ checkout_token: string; outcome: 'success' | 'failed' | 'cancelled' }>(submitValidator, request.body)
    const payment = await finishPayment(db, config, token, outcome)
    await dependencies.schedule()
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    return response.type('html').send(htmlPage(payment, token, `Payment ${payment.status}.`, true))
  })
}

export async function statusByReference(db: Knex, reference: string) { return await existingPayment(db, reference) }
