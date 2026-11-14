import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import type { NextFunction, Request, Response } from 'express'
import { requestIdValidator, validate } from './validation.js'

interface RequestContext { requestId: string }
export const requestContext = new AsyncLocalStorage<RequestContext>()
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['req.headers.authorization', 'authorization', 'serviceSecret', 'webhookSecret', 'checkout_token', 'token'], censor: '[REDACTED]' },
})

function safePath(request: Request): string {
  if (request.path.startsWith('/checkout/')) return '/checkout/:token'
  return request.route?.path ? `${request.baseUrl}${request.route.path}` : request.path
}

export async function requestLogging(request: Request, response: Response, next: NextFunction) {
  const supplied = request.header('x-request-id')?.trim() ?? ''
  let requestId: string = randomUUID()
  if (supplied) {
    try { requestId = (await validate<{ request_id: string }>(requestIdValidator, { request_id: supplied })).request_id }
    catch { /* Replace invalid upstream IDs. */ }
  }
  response.setHeader('X-Request-ID', requestId)
  requestContext.run({ requestId }, () => {
    const started = process.hrtime.bigint()
    response.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
      logger.info({ request_id: requestId, method: request.method, path: safePath(request), status: response.statusCode,
        auth_state: request.header('authorization') ? 'present' : request.path.startsWith('/checkout/') ? 'capability' : 'absent',
        request_size: Number(request.header('content-length') ?? 0), response_size: Number(response.getHeader('content-length') ?? 0),
        duration_ms: Math.round(durationMs * 100) / 100 }, 'provider request completed')
    })
    next()
  })
}

export function currentRequestId() { return requestContext.getStore()?.requestId ?? randomUUID() }
