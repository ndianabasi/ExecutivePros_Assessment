import type { Express, Request, Response } from 'express'
import type { Knex } from 'knex'
import { authenticatedUser, requireAuth } from './auth-middleware.js'
import { currentRequestId, logger } from './logging.js'
import type { ApiConfig } from './config.js'
import { PaymentEventHub, type PaymentActivityEvent } from './payment-events.js'

function writeEvent(response: Response, event: PaymentActivityEvent) {
  if (response.destroyed || response.writableEnded) return
  response.write(`id: ${event.id}\nevent: payment-activity\ndata: ${JSON.stringify(event)}\n\n`)
}

export function registerPaymentEventRoutes(app: Express, db: Knex, hub: PaymentEventHub, config: ApiConfig) {
  app.get('/v1/events', requireAuth(db), (request: Request, response: Response) => {
    const user = authenticatedUser(request)
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    const unsubscribe = hub.subscribe(user.userId, {
      send(event) { writeEvent(response, event) },
      close() { if (!response.writableEnded) response.end() },
    })
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(`: heartbeat ${Date.now()}\n\n`)
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
