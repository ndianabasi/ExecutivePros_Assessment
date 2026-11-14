import { timingSafeEqual } from 'node:crypto'
import vine, { errors } from '@vinejs/vine'
import type { NextFunction, Request, Response } from 'express'

const authorizationValidator = vine.create(
  vine.object({
    authorization: vine.string().regex(/^Bearer [\x21-\x7e]+$/),
  }),
)

/**
 * Creates middleware that compares a service credential with the configured secret.
 *
 * @param expected - Expected configuration or evidence value used in the equality check.
 */
export function authenticateServiceSecret(expected: string) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const { authorization } = await authorizationValidator.validate({
        authorization: request.header('authorization'),
      })
      const suppliedBytes = Buffer.from(authorization.slice('Bearer '.length))
      const expectedBytes = Buffer.from(expected)
      const valid =
        expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
      if (!valid) {
        return response.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Service authentication required',
            request_id: response.locals.requestId,
          },
        })
      }
      return next()
    } catch (error) {
      if (error instanceof errors.E_VALIDATION_ERROR) {
        return response.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Service authentication required',
            request_id: response.locals.requestId,
          },
        })
      }
      return next(error)
    }
  }
}
