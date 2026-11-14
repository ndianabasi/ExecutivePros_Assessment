import type { Express, Request, Response } from 'express'
import type { Knex } from 'knex'
import { authenticatedUser, requireAuth } from './auth-middleware.js'
import { currentRequestId, logger } from './logging.js'
import type { ApiConfig } from './config.js'
import { PaymentEventHub, type PaymentActivityEvent } from './payment-events.js'

/**
 * Writes one encoded payment activity record to an open Server-Sent Events response.
 *
 * @param response - HTTP response or upstream dependency response whose status and body are handled by this operation.
 * @param event - Payment or webhook event being processed and reported.
 */
function writeEvent(response: Response, event: PaymentActivityEvent) {
  if (response.destroyed || response.writableEnded) {
    return
  }
  response.write(`id: ${event.id}\nevent: payment-activity\ndata: ${JSON.stringify(event)}\n\n`)
}

/**
 * Registers the authenticated owner-scoped payment activity SSE endpoint and heartbeat lifecycle.
 *
 * @param app - Express application to which middleware and route handlers are attached.
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param hub - Process-local event hub used to publish owner-scoped payment activity.
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 */
export function registerPaymentEventRoutes(app: Express, db: Knex, hub: PaymentEventHub, config: ApiConfig) {
  app.get('/v1/events', requireAuth(db), (request: Request, response: Response) => {
    const user = authenticatedUser(request)
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    const unsubscribe = hub.subscribe(user.userId, {
      /**
       * Submits the validated notification through the configured transport and reports delivery failures to the worker.
       *
       * @param event - Payment or webhook event being processed and reported.
       */
      send(event) {
        writeEvent(response, event)
      },

      /**
       * Closes the owned stream, transport, database, or worker resources and releases their listeners.
       */
      close() {
        if (!response.writableEnded) {
          response.end()
        }
      },
    })
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`: heartbeat ${Date.now()}\n\n`)
      }
    }, config.sseHeartbeatMs)
    response.once('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      logger.debug({ request_id: currentRequestId(), user_id: user.userId }, 'payment event stream closed')
    })
    response.flushHeaders()
    response.write(': connected\n\n')
  })
}
