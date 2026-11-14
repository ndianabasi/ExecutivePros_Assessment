import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response, RequestHandler } from 'express'
import { ProviderHttpError } from './errors.js'
import type { ProviderConfig } from './config.js'
import { authorizationValidator, validate } from './validation.js'

export function requireService(config: ProviderConfig): RequestHandler {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      const { authorization } = await validate<{ authorization: string }>(authorizationValidator, { authorization: request.header('authorization') ?? '' })
      const supplied = Buffer.from(authorization.slice(7))
      const expected = Buffer.from(config.serviceSecret)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ProviderHttpError(401, 'unauthorized', 'A valid provider service token is required')
      next()
    } catch {
      next(new ProviderHttpError(401, 'unauthorized', 'A valid provider service token is required'))
    }
  }
}
