import { createHash } from 'node:crypto'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import type { QueueConfig } from './config.js'
import type { EmailJob } from './jobs.js'
import { logger } from './logger.js'
import { requestId, validateEmailJob } from './validation.js'
import { authenticateServiceSecret } from './auth.js'
import { createHealthRouter } from './health.js'

export interface QueueClient {
  add(payload: EmailJob, options: { maxAttempts: number }): Promise<{ ok: boolean; id: string }>
}
export interface QueueWorker {
  readonly isRunning: boolean
}
export interface QueueReadiness {
  isDbWritable(): boolean
}

/**
 * Builds and configures the service Express application, registers middleware and routes, and returns it for serving or tests.
 *
 * @param dependencies - Service dependencies and runtime capabilities injected into the application factory.
 *
 * @returns The configured object, route set, or resource produced by this operation.
 */
export function createApp(dependencies: {
  config: QueueConfig
  client: QueueClient
  worker: QueueWorker
  readiness: QueueReadiness
}): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    void requestId(req)
      .then((id) => {
        res.locals.requestId = id
        res.setHeader('x-request-id', id)
        const startedAt = performance.now()
        res.on('finish', () => {
          return logger.info(
            {
              requestId: id,
              method: req.method,
              path: req.path,
              status: res.statusCode,
              durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
            },
            'HTTP request completed',
          )
        })
        next()
      })
      .catch(next)
  })
  app.use(
    '/health',
    createHealthRouter({
      isDbWritable: dependencies.readiness.isDbWritable,
      isWorkerRunning: () => {
        return dependencies.worker.isRunning
      },
    }),
  )
  app.post(
    '/jobs',
    authenticateServiceSecret(dependencies.config.serviceSecret),
    (request, response, next) => {
      if (!request.is('application/json')) {
        return response.status(400).json({
          error: {
            code: 'JSON_REQUIRED',
            message: 'Content-Type must be application/json',
            request_id: response.locals.requestId,
          },
        })
      }
      next()
    },
    express.json({ limit: '64kb', strict: true, type: 'application/json' }),
    async (request, response) => {
      const id = response.locals.requestId as string
      const validation = await validateEmailJob(request.body, id)
      if (!validation.ok) {
        return response.status(validation.status).json({
          error: {
            code: validation.status === 400 ? 'INVALID_REQUEST' : 'INVALID_EMAIL',
            message: validation.message,
            request_id: id,
          },
        })
      }
      const startedAt = performance.now()
      try {
        const result = await dependencies.client.add(validation.value, {
          maxAttempts: dependencies.config.maxAttempts,
        })
        if (!result.ok || !result.id) {
          throw new Error('Workmatic did not confirm durable enqueue')
        }
        logger.info(
          {
            requestId: id,
            jobId: result.id,
            notificationHash: hashNotificationKey(validation.value.notification_key),
            paymentReference: validation.value.payment_reference,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          },
          'Email job durably enqueued',
        )
        return response.status(202).json({ job_id: result.id, status: 'queued', request_id: id })
      } catch (error) {
        logger.error(
          {
            requestId: id,
            notificationHash: hashNotificationKey(validation.value.notification_key),
            paymentReference: validation.value.payment_reference,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          },
          'Email enqueue failed or was uncertain',
        )
        return response.status(503).json({
          error: {
            code: 'QUEUE_UNAVAILABLE',
            message: 'Unable to confirm durable enqueue',
            request_id: id,
          },
        })
      }
    },
  )
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const id = response.locals.requestId as string | undefined
    if (error instanceof SyntaxError && 'body' in error) {
      return response
        .status(400)
        .json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON request body', request_id: id } })
    }
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      return response.status(413).json({
        error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds 64 KiB', request_id: id },
      })
    }
    logger.error(
      {
        requestId: id,
        method: request.method,
        path: request.path,
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      },
      'Unhandled queue request error',
    )
    return response
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected queue error', request_id: id } })
  })
  return app
}

/**
 * Determines whether hash notification key satisfies the condition required by the caller.
 *
 * @param key - Stable idempotency or notification key used to correlate repeated submissions.
 *
 * @returns Whether the supplied value satisfies the documented condition.
 */
function hashNotificationKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}
