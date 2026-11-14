import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import type { NextFunction, Request, Response } from 'express'
import { requestIdHeaderValidator, validate } from './validation.js'

interface RequestContext {
  requestId: string
  userId?: number
  role?: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'authorization', 'token', 'secret', 'webhook_body'],
    censor: '[REDACTED]',
  },
})

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
      requestId = (await validate<{ request_id: string }>(requestIdHeaderValidator, { request_id: supplied }))
        .request_id
    } catch {
      /* Invalid caller IDs are replaced with a server-generated value. */
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
          path: request.path,
          status: response.statusCode,
          auth_state: request.header('authorization') ? 'present' : 'absent',
          user_id: requestContext.getStore()?.userId,
          role: requestContext.getStore()?.role,
          request_size: Number(request.header('content-length') ?? 0),
          response_size: Number(response.getHeader('content-length') ?? 0),
          duration_ms: Math.round(durationMs * 100) / 100,
        },
        'http request completed',
      )
    })
    next()
  })
}

/**
 * Returns the request identifier from the active asynchronous request context when available.
 *
 * @returns The active request ID, or undefined when no request context is active.
 */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId
}
