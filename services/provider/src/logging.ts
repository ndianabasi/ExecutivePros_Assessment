import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import type { NextFunction, Request, Response } from 'express'
import { requestIdValidator, validate } from './validation.js'

interface RequestContext {
  requestId: string
}
export const requestContext = new AsyncLocalStorage<RequestContext>()
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'authorization',
      'serviceSecret',
      'webhookSecret',
      'checkout_token',
      'token',
    ],
    censor: '[REDACTED]',
  },
})

/**
 * Removes query parameters from a request path before the path is written to logs.
 *
 * @param request - Incoming HTTP request containing route input and authenticated request context.
 *
 * @returns The request path with its query string removed.
 */
function safePath(request: Request): string {
  if (request.path.startsWith('/checkout/')) {
    return '/checkout/:token'
  }
  return request.route?.path ? `${request.baseUrl}${request.route.path}` : request.path
}

/**
 * Logs request metadata and response timing without recording credentials or sensitive payloads.
 *
 * @param request - Incoming HTTP request containing route input and authenticated request context.
 * @param response - HTTP response or upstream dependency response whose status and body are handled by this operation.
 * @param next - Express continuation callback used to pass control or a failure to the next middleware.
 */
export async function requestLogging(request: Request, response: Response, next: NextFunction) {
  const supplied = request.header('x-request-id')?.trim() ?? ''
  let requestId: string = randomUUID()
  if (supplied) {
    try {
      requestId = (await validate<{ request_id: string }>(requestIdValidator, { request_id: supplied }))
        .request_id
    } catch {
      /* Replace invalid upstream IDs. */
    }
  }
  response.setHeader('X-Request-ID', requestId)
  requestContext.run({ requestId }, () => {
    const started = process.hrtime.bigint()
    response.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
      logger.info(
        {
          request_id: requestId,
          method: request.method,
          path: safePath(request),
          status: response.statusCode,
          auth_state: request.header('authorization')
            ? 'present'
            : request.path.startsWith('/checkout/')
              ? 'capability'
              : 'absent',
          request_size: Number(request.header('content-length') ?? 0),
          response_size: Number(response.getHeader('content-length') ?? 0),
          duration_ms: Math.round(durationMs * 100) / 100,
        },
        'provider request completed',
      )
    })
    next()
  })
}

/**
 * Returns the request identifier from the active asynchronous request context when available.
 */
export function currentRequestId() {
  return requestContext.getStore()?.requestId ?? randomUUID()
}
