import type { Express } from 'express'
import type { Knex } from 'knex'
import { authenticatedUser } from './auth-middleware.js'
import { HttpError } from './errors.js'
import { pageQueryValidator, positiveIdValidator, validate } from './validation.js'

function pageArgs(query: { page?: number; page_size?: number }) {
  const page = query.page ?? 1
  const pageSize = query.page_size ?? 20
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset)) throw new HttpError(400, 'invalid_page', 'Requested page is outside the supported range')
  return { page, pageSize, offset }
}

export function registerPaymentReadRoutes(app: Express, db: Knex) {
  app.get('/v1/payments', async (request, response) => {
    const user = authenticatedUser(request)
    const query = await validate<{ page?: number; page_size?: number }>(pageQueryValidator, request.query, 'invalid_pagination', 'page and page_size must be positive integers; page_size cannot exceed 100')
    const { page, pageSize, offset } = pageArgs(query)
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
    const { id: paymentId } = await validate<{ id: number }>(positiveIdValidator, { id: request.params.payment_id }, 'invalid_payment_id', 'payment_id must be a positive integer')
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
    const safePayment = { ...payment }
    delete safePayment.fulfillment_id
    const fulfilledAt = safePayment.fulfilled_at
    delete safePayment.fulfilled_at
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: {
      ...safePayment,
      cart: { id: payment.cart_id, items },
      fulfillment: payment.fulfillment_id ? { created_at: fulfilledAt, items: fulfillmentItems } : null,
      incidents,
    } })
  })
}
