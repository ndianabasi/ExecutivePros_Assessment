import type { Express, Request } from 'express'
import type { Knex } from 'knex'
import { authenticatedUser } from './auth-middleware.js'
import { HttpError } from './errors.js'

function positiveInteger(value: unknown, name: string, fallback?: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = value === undefined && fallback !== undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new HttpError(400, `invalid_${name}`, `${name} must be a positive integer no greater than ${max}`)
  return number
}

function pageArgs(request: Request) {
  const page = positiveInteger(request.query.page, 'page', 1)
  const pageSize = positiveInteger(request.query.page_size, 'page_size', 20, 100)
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset)) throw new HttpError(400, 'invalid_page', 'Requested page is outside the supported range')
  return { page, pageSize, offset }
}

export function registerPaymentReadRoutes(app: Express, db: Knex) {
  app.get('/v1/payments', async (request, response) => {
    const user = authenticatedUser(request)
    const { page, pageSize, offset } = pageArgs(request)
    const ownerFilter = user.role === 'admin' ? '' : 'WHERE p.user_id = :user_id'
    const bindings = user.role === 'admin' ? { limit: pageSize, offset } : { user_id: user.userId, limit: pageSize, offset }
    const rows = await db.raw(
      `SELECT p.id, p.reference, p.cart_id, p.status, p.amount_minor, p.currency,
              p.payment_url, p.failure_scenario_code, p.created_at, p.completed_at,
              CASE WHEN f.id IS NULL THEN 0 ELSE 1 END AS fulfilled
       FROM payments p LEFT JOIN fulfillments f ON f.payment_id = p.id ${ownerFilter}
       ORDER BY p.created_at DESC, p.id DESC LIMIT :limit OFFSET :offset`, bindings,
    ) as Array<Record<string, unknown>>
    const totals = await db.raw(`SELECT COUNT(*) AS total FROM payments p ${ownerFilter}`, user.role === 'admin' ? {} : { user_id: user.userId }) as Array<{ total: number }>
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: rows, meta: { page, page_size: pageSize, total: Number(totals[0]?.total ?? 0) } })
  })

  app.get('/v1/payments/:payment_id', async (request, response) => {
    const user = authenticatedUser(request)
    const paymentId = positiveInteger(request.params.payment_id, 'payment_id')
    const ownerFilter = user.role === 'admin' ? '' : 'AND p.user_id = :user_id'
    const bindings = user.role === 'admin' ? { payment_id: paymentId } : { payment_id: paymentId, user_id: user.userId }
    const payment = (await db.raw(
      `SELECT p.id, p.user_id, p.cart_id, p.reference, p.status, p.amount_minor, p.currency,
              p.payment_url, p.initialisation_state, p.failure_scenario_code, p.checkout_expires_at,
              p.created_at, p.updated_at, p.completed_at, p.provider_transaction_reference,
              f.id AS fulfillment_id, f.created_at AS fulfilled_at
       FROM payments p LEFT JOIN fulfillments f ON f.payment_id = p.id
       WHERE p.id = :payment_id ${ownerFilter}`, bindings,
    ) as Array<Record<string, unknown>>)[0]
    if (!payment) throw new HttpError(404, 'payment_not_found', 'Payment not found')

    const items = await db.raw(
      `SELECT product_id, product_name, quantity, unit_price_minor, currency, line_total_minor
       FROM cart_items WHERE cart_id = :cart_id ORDER BY product_id`, { cart_id: payment.cart_id },
    ) as Array<Record<string, unknown>>
    const fulfillmentItems = payment.fulfillment_id ? await db.raw(
      `SELECT product_id, product_name, quantity, unit_price_minor, currency, line_total_minor
       FROM fulfillment_items WHERE fulfillment_id = :id ORDER BY product_id`, { id: payment.fulfillment_id },
    ) as Array<Record<string, unknown>> : []
    const incidents = await db.raw(
      `SELECT id, code, redacted_details, created_at, resolved_at FROM payment_incidents
       WHERE payment_id = :id ORDER BY id DESC`, { id: payment.id },
    ) as Array<Record<string, unknown>>
    const { fulfillment_id: _fulfillmentId, fulfilled_at, ...safePayment } = payment
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: {
      ...safePayment,
      cart: { id: payment.cart_id, items },
      fulfillment: payment.fulfillment_id ? { created_at: fulfilled_at, items: fulfillmentItems } : null,
      incidents,
    } })
  })
}
