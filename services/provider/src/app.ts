import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'
import type { WorkmaticWorker } from 'workmatic'
import type { ProviderConfig } from './config.js'
import { requireService } from './auth.js'
import { ProviderHttpError } from './errors.js'
import { currentRequestId, logger, requestLogging } from './logging.js'
import { registerPaymentRoutes } from './payments.js'

/**
 * Builds and configures the service Express application, registers middleware and routes, and returns it for serving or tests.
 *
 * @param dependencies - Service dependencies and runtime capabilities injected into the application factory.
 *
 * @returns The configured object, route set, or resource produced by this operation.
 */
export function createApp(dependencies: {
  db: Knex
  config: ProviderConfig
  isReady: () => boolean | Promise<boolean>
  worker: WorkmaticWorker
  scheduleDueEvents: () => Promise<void>
  diagnostics: () => Promise<Record<string, unknown>>
}): Express {
  const { db, config, isReady, worker, scheduleDueEvents, diagnostics } = dependencies
  const app = express()
  app.disable('x-powered-by')
  app.use(requestLogging)
  app.use((_request, response, next) => {
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors ${config.frontendOrigin}`,
    )
    response.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  app.use(express.json({ limit: '32kb', strict: true }))
  app.use('/payments/submit', express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 4 }))

  app.get('/health/live', (_request, response) => {
    return response.status(200).json({ status: 'live' })
  })
  app.get('/health/ready', async (_request, response) => {
    if (!worker.isRunning || !(await isReady())) {
      return response.status(503).json({ status: 'not_ready' })
    }
    return response.status(200).json({ status: 'ready' })
  })

  const service = requireService(config)
  app.get('/diagnostics', service, async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    return response.json({ data: await diagnostics() })
  })
  registerPaymentRoutes(app, db, config, { schedule: scheduleDueEvents, serviceAuth: service })

  app.use((_request, response) => {
    return response
      .status(404)
      .json({ error: { code: 'not_found', message: 'Route not found', request_id: currentRequestId() } })
  })
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const parseError =
      typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed'
    const tooLarge =
      typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large'
    const status = error instanceof ProviderHttpError ? error.status : parseError ? 400 : tooLarge ? 413 : 500
    const code =
      error instanceof ProviderHttpError
        ? error.code
        : parseError
          ? 'invalid_json'
          : tooLarge
            ? 'request_too_large'
            : 'internal_error'
    const message =
      error instanceof ProviderHttpError
        ? error.message
        : parseError
          ? 'Request body must be valid JSON'
          : tooLarge
            ? 'Request body exceeds the limit'
            : 'An unexpected error occurred'
    if (status >= 500) {
      logger.error({ error_type: error instanceof Error ? error.name : 'unknown' }, 'provider request failed')
    }
    return response.status(status).json({ error: { code, message, request_id: currentRequestId() } })
  })
  return app
}
