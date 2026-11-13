import type { Knex } from 'knex'
import type { Request, Response } from 'express'
import { authenticate } from './auth.js'
import { HttpError } from './errors.js'
import { immediate, type SqliteTransaction } from './sqlite.js'

type Row = Record<string, unknown>

function positiveInt(value: unknown, name: string): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(number) || Number(number) <= 0) throw new HttpError(400, 'invalid_input', `${name} must be a positive integer`)
  return Number(number)
}

async function requireUser(db: Knex, request: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(request.header('authorization') ?? '')
  if (!match) throw new HttpError(401, 'unauthorized', 'A valid Bearer token is required')
  const user = await authenticate(db, match[1]!)
  if (!user) throw new HttpError(401, 'unauthorized', 'The Bearer token is invalid or expired')
  return user
}

async function activeCart(tx: SqliteTransaction, userId: number): Promise<Row | undefined> {
  return (await tx.query('SELECT * FROM carts WHERE user_id = :user_id AND status = :status', { user_id: userId, status: 'active' }))[0]
}

async function cartPayload(db: Knex, cart: Row) {
  const items = await db.raw(
    `SELECT ci.product_id, ci.product_name, ci.unit_price_minor, ci.quantity, ci.line_total_minor
     FROM cart_items ci WHERE ci.cart_id = :cart_id ORDER BY ci.product_id`, { cart_id: cart.id },
  ) as Row[]
  return { ...cart, items }
}

async function recompute(tx: SqliteTransaction, cartId: number) {
  const totals = await tx.query<{ total_minor: number; currency: string; item_count: number }>(
    `SELECT COALESCE(SUM(line_total_minor), 0) AS total_minor,
            COALESCE(MIN(p.currency), 'NGN') AS currency, COUNT(*) AS item_count
     FROM cart_items ci LEFT JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = :cart_id`,
    { cart_id: cartId },
  )
  const row = totals[0]
  if (!row) throw new Error('Cart total query returned no row')
  if (!Number.isSafeInteger(Number(row.total_minor)) || Number(row.total_minor) > Number.MAX_SAFE_INTEGER) {
    throw new HttpError(409, 'amount_overflow', 'Cart total exceeds the supported amount')
  }
  await tx.query('UPDATE carts SET total_minor = :total, currency = :currency, updated_at = CURRENT_TIMESTAMP WHERE id = :id', {
    total: Number(row.total_minor), currency: row.currency, id: cartId,
  })
}

async function addItem(tx: SqliteTransaction, cartId: number, item: { product_id: number; quantity: number }) {
  const product = (await tx.query<{ id: number; name: string; price_minor: number; currency: string; stock_quantity: number; stock_reserved: number; is_active: number }>(
    `SELECT id, name, price_minor, currency, stock_quantity, stock_reserved, is_active FROM products WHERE id = :id`, { id: item.product_id },
  ))[0]
  if (!product || Number(product.is_active) !== 1) throw new HttpError(409, 'product_unavailable', 'A selected product is unavailable')
  const cart = (await tx.query<{ currency: string }>('SELECT currency FROM carts WHERE id = :id', { id: cartId }))[0]
  if (!cart) throw new Error('Cart disappeared during item update')
  if (cart.currency !== product.currency) throw new HttpError(409, 'currency_mismatch', 'All cart items must use the same currency')
  const previous = (await tx.query<{ quantity: number }>(
    'SELECT quantity FROM cart_items WHERE cart_id = :cart_id AND product_id = :product_id',
    { cart_id: cartId, product_id: item.product_id },
  ))[0]
  const quantity = Number(previous?.quantity ?? 0) + item.quantity
  const reserved = (await tx.query<{ quantity: number }>(
    "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM stock_reservations WHERE product_id = :id AND status = 'active'",
    { id: item.product_id },
  ))[0]
  if (Number(product.stock_quantity) - Number(reserved?.quantity ?? 0) < quantity) {
    throw new HttpError(409, 'stock_unavailable', 'The requested product quantity is unavailable')
  }
  const lineTotal = Number(product.price_minor) * quantity
  if (!Number.isSafeInteger(lineTotal)) throw new HttpError(400, 'amount_overflow', 'Cart item total exceeds the supported amount')
  await tx.query(
    `INSERT INTO cart_items(cart_id, product_id, product_name, unit_price_minor, quantity, line_total_minor)
     VALUES (:cart_id, :product_id, :name, :unit_price, :quantity, :line_total)
     ON CONFLICT(cart_id, product_id) DO UPDATE SET product_name = excluded.product_name,
       unit_price_minor = excluded.unit_price_minor, quantity = excluded.quantity, line_total_minor = excluded.line_total_minor`,
    { cart_id: cartId, product_id: item.product_id, name: product.name, unit_price: product.price_minor, quantity, line_total: lineTotal },
  )
}

export function registerCartRoutes(app: import('express').Express, db: Knex) {
  app.get('/v1/cart', async (request, response) => {
    const user = await requireUser(db, request)
    const cart = await db('carts').where({ user_id: user.userId, status: 'active' }).first()
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: cart ? await cartPayload(db, cart) : null })
  })

  app.post('/v1/cart', async (request, response) => {
    const user = await requireUser(db, request)
    const rawItems = request.body?.items
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 50) throw new HttpError(400, 'invalid_items', 'items must contain between 1 and 50 entries')
    const items = rawItems.map((item, index) => ({
      product_id: positiveInt(item?.product_id, `items[${index}].product_id`),
      quantity: positiveInt(item?.quantity, `items[${index}].quantity`),
    }))
    const cartId = await immediate(db, async (tx) => {
      let cart = await activeCart(tx, user.userId)
      if (!cart) {
        const result = await tx.query<{ id: number }>(
          `INSERT INTO carts(user_id, status, currency, total_minor) VALUES (:user_id, 'active', 'NGN', 0) RETURNING id`, { user_id: user.userId },
        )
        cart = { id: result[0]!.id }
      }
      for (const item of items) await addItem(tx, Number(cart.id), item)
      await recompute(tx, Number(cart.id))
      return Number(cart.id)
    })
    const cart = await db('carts').where({ id: cartId }).first()
    response.status(200).json({ data: await cartPayload(db, cart) })
  })

  app.patch('/v1/cart/items/:product_id', async (request, response) => {
    const user = await requireUser(db, request)
    const productId = positiveInt(request.params.product_id, 'product_id')
    const quantity = positiveInt(request.body?.quantity, 'quantity')
    const cartId = await immediate(db, async (tx) => {
      const cart = await activeCart(tx, user.userId)
      if (!cart) throw new HttpError(404, 'cart_not_found', 'No active cart exists')
      const existing = (await tx.query('SELECT product_id FROM cart_items WHERE cart_id = :cart_id AND product_id = :product_id', { cart_id: cart.id, product_id: productId }))[0]
      if (!existing) throw new HttpError(404, 'cart_item_not_found', 'The item is not in the active cart')
      await tx.query('DELETE FROM cart_items WHERE cart_id = :cart_id AND product_id = :product_id', { cart_id: cart.id, product_id: productId })
      await addItem(tx, Number(cart.id), { product_id: productId, quantity })
      await recompute(tx, Number(cart.id))
      return Number(cart.id)
    })
    response.json({ data: await cartPayload(db, await db('carts').where({ id: cartId }).first()) })
  })

  app.delete('/v1/cart/items/:product_id', async (request, response) => {
    const user = await requireUser(db, request)
    const productId = positiveInt(request.params.product_id, 'product_id')
    await immediate(db, async (tx) => {
      const cart = await activeCart(tx, user.userId)
      if (!cart) return
      await tx.query('DELETE FROM cart_items WHERE cart_id = :cart_id AND product_id = :product_id', { cart_id: cart.id, product_id: productId })
      await recompute(tx, Number(cart.id))
    })
    response.status(204).end()
  })

  app.delete('/v1/cart', async (request, response) => {
    const user = await requireUser(db, request)
    await immediate(db, async (tx) => {
      await tx.query("UPDATE carts SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP WHERE user_id = :user_id AND status = 'active'", { user_id: user.userId })
    })
    response.status(204).end()
  })

  app.get('/v1/carts/:cart_id', async (request, response) => {
    const user = await requireUser(db, request)
    const cartId = positiveInt(request.params.cart_id, 'cart_id')
    const cart = await db('carts').where({ id: cartId }).first()
    if (!cart || (cart.user_id !== user.userId && user.role !== 'admin')) throw new HttpError(404, 'cart_not_found', 'Cart not found')
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: await cartPayload(db, cart) })
  })
}
