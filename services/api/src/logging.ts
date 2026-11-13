import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import type { NextFunction, Request, Response } from 'express'

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

export function requestLogging(request: Request, response: Response, next: NextFunction) {
  const supplied = request.header('x-request-id')?.trim() ?? ''
  const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID()
  response.setHeader('X-Request-ID', requestId)
  requestContext.run({ requestId }, () => {
    const started = process.hrtime.bigint()
    response.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
      logger.info({
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
      }, 'http request completed')
    })
    next()
  })
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId
}
