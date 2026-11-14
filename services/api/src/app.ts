import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'
import { authenticate, listDemoUsers, login, logout } from './auth.js'
import { registerCartRoutes } from './carts.js'
import { HttpError } from './errors.js'
import { currentRequestId, logger, requestLogging } from './logging.js'
import { registerCheckoutRoutes } from './checkout.js'
import { ProviderClient } from './provider.js'
import type { ApiConfig } from './config.js'
import { registerWebhookRoutes } from './webhooks.js'
import { registerPaymentReadRoutes } from './payment-reads.js'
import { requireAuth } from './auth-middleware.js'
import { authorizationHeaderValidator, loginValidator, productQueryValidator, validate } from './validation.js'
import { PaymentEventHub } from './payment-events.js'
import { registerPaymentEventRoutes } from './sse.js'

export interface AppDependencies {
  db: Knex
  isReady: () => boolean | Promise<boolean>
  frontendOrigin: string
  docsOrigin: string
  provider?: ProviderClient
  config?: ApiConfig
  eventHub?: PaymentEventHub
}

function fail(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message, request_id: currentRequestId() } })
}

export function createApp({ db, isReady, frontendOrigin, docsOrigin, provider, config, eventHub = new PaymentEventHub() }: AppDependencies): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(requestLogging)
  app.use((request, response, next) => {
    const origin = request.header('origin')
    if (origin === frontendOrigin || origin === docsOrigin) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    }
    if (request.method === 'OPTIONS') return response.sendStatus(204)
    next()
  })
  app.use('/v1/webhooks/payment', express.raw({ type: 'application/json', limit: '32kb' }))
  app.use(express.json({ limit: '64kb', strict: true }))

  app.get('/health/live', (_request: Request, response: Response) => {
    response.status(200).json({ status: 'live' })
  })

  app.get('/health/ready', async (_request: Request, response: Response) => {
    if (!(await isReady())) return response.status(503).json({ status: 'not_ready' })
    return response.status(200).json({ status: 'ready' })
  })

  app.get('/v1/demo/users', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: await listDemoUsers(db) })
  })

  app.post('/v1/login', async (request, response, next) => {
    try {
      const { user_id: userId } = await validate<{ user_id: number }>(loginValidator, request.body, 'invalid_user_id', 'user_id must be a positive integer')
      const result = await login(db, userId)
      response.setHeader('Cache-Control', 'no-store')
      response.json({ data: { token: result.token, user: result.user } })
    } catch (error) { next(error) }
  })

  app.post('/v1/logout', async (request, response, next) => {
    try {
      let authorization: string
      try {
        authorization = (await validate<{ authorization: string }>(authorizationHeaderValidator, { authorization: request.header('authorization') ?? '' }, 'unauthorized', 'A valid Bearer token is required')).authorization
      } catch { return fail(response, 401, 'unauthorized', 'A valid Bearer token is required') }
      const token = authorization.slice('Bearer '.length)
      const context = await authenticate(db, token)
      if (!context) return fail(response, 401, 'unauthorized', 'The Bearer token is invalid or expired')
      await logout(db, context.tokenId)
      response.status(204).end()
    } catch (error) { next(error) }
  })

  app.use('/v1/products', requireAuth(db))
  app.use('/v1/cart', requireAuth(db))
  app.use('/v1/carts', requireAuth(db))
  app.use('/v1/failure-scenarios', requireAuth(db))
  app.use('/v1/payments', requireAuth(db))

  app.get('/v1/products', async (request, response, next) => {
    try {
      const query = await validate<{ page?: number; page_size?: number }>(productQueryValidator, request.query, 'invalid_pagination', 'page must be positive and page_size must be between 1 and 100')
      const page = query.page ?? 1
      const pageSize = query.page_size ?? 20
      const offset = (page - 1) * pageSize
      const data = await db.raw(
        `SELECT id, name, description, sku, price_minor, currency,
                (stock_quantity - COALESCE((SELECT SUM(sr.quantity) FROM stock_reservations sr
                   WHERE sr.product_id = products.id AND sr.status = 'active'), 0)) AS available_stock
         FROM products WHERE is_active = 1 ORDER BY id ASC LIMIT :limit OFFSET :offset`,
        { limit: pageSize, offset },
      ) as Array<Record<string, unknown>>
      const count = await db.raw('SELECT COUNT(*) AS total FROM products WHERE is_active = 1') as Array<{ total: number }>
      response.setHeader('Cache-Control', 'no-store')
      response.json({ data, meta: { page, page_size: pageSize, total: Number(count[0]?.total ?? 0) } })
    } catch (error) { next(error) }
  })

  registerCartRoutes(app, db)
  registerPaymentReadRoutes(app, db)
  if (provider && config) registerCheckoutRoutes(app, db, provider, config)
  if (config) {
    registerPaymentEventRoutes(app, db, eventHub, config)
    registerWebhookRoutes(app, db, config.providerWebhookSecret, eventHub)
  }

  app.use((_request: Request, response: Response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Route not found', request_id: currentRequestId() } })
  })

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const parseError = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed'
    const status = error instanceof HttpError ? error.status : parseError ? 400 : 500
    const code = error instanceof HttpError ? error.code : parseError ? 'invalid_json' : 'internal_error'
    const message = error instanceof HttpError ? error.message : parseError ? 'Request body must be valid JSON' : 'An unexpected error occurred'
    if (status >= 500) logger.error({ request_id: currentRequestId(), error_type: error instanceof Error ? error.name : 'unknown' }, 'request failed')
    const details = error instanceof HttpError ? error.details : undefined
    response.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }), request_id: currentRequestId() } })
  })

  return app
}
