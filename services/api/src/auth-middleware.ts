import type { NextFunction, Request, Response, RequestHandler } from 'express'
import type { Knex } from 'knex'
import { authenticate, type AuthContext } from './auth.js'
import { HttpError } from './errors.js'
import { requestContext } from './logging.js'

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext
    }
  }
}

export function requireAuth(db: Knex): RequestHandler {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(request.header('authorization') ?? '')
      if (!match) throw new HttpError(401, 'unauthorized', 'A valid Bearer token is required')
      const user = await authenticate(db, match[1]!)
      if (!user) throw new HttpError(401, 'unauthorized', 'The Bearer token is invalid or expired')
      request.auth = user
      const context = requestContext.getStore()
      if (context) {
        context.userId = user.userId
        context.role = user.role
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

export function requireAdmin(): RequestHandler {
  return (request, _response, next) => {
    if (request.auth?.role !== 'admin') return next(new HttpError(403, 'forbidden', 'An admin role is required'))
    next()
  }
}

export function authenticatedUser(request: Request): AuthContext {
  if (!request.auth) throw new Error('Protected route was registered without requireAuth middleware')
  return request.auth
}
