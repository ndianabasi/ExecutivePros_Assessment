import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import type { Knex } from 'knex'
import { currentRequestId, logger } from './logging.js'
import { applyPaymentEvidence, recordInvalidWebhook, type TerminalPaymentStatus } from './payment-transitions.js'

interface WebhookBody {
  event_id: string
  event_type: string
  status: TerminalPaymentStatus
  reference: string
  provider_reference?: string
  amount: number
  currency: string
  occurred_at?: string
}

function error(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message, request_id: currentRequestId() } })
}

function parseBody(value: unknown): WebhookBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const allowed = ['event_id', 'event_type', 'status', 'reference', 'provider_reference', 'amount', 'currency', 'occurred_at']
  if (Object.keys(body).some((key) => !allowed.includes(key))) return null
  if (typeof body.event_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.event_id)) return null
  if (typeof body.reference !== 'string' || !/^pay_[A-Za-z0-9_-]{16,80}$/.test(body.reference)) return null
  if (!Number.isSafeInteger(body.amount) || Number(body.amount) <= 0 || body.currency !== 'NGN') return null
  if (body.status !== 'success' && body.status !== 'failed' && body.status !== 'cancelled') return null
  const expected = `payment.${body.status}`
  if (body.event_type !== expected) return null
  if (body.provider_reference !== undefined && (typeof body.provider_reference !== 'string' || body.provider_reference.length > 160)) return null
  if (body.occurred_at !== undefined && (typeof body.occurred_at !== 'string' || Number.isNaN(Date.parse(body.occurred_at)))) return null
  return body as unknown as WebhookBody
}

function busy(errorValue: unknown) {
  return typeof errorValue === 'object' && errorValue !== null && 'code' in errorValue &&
    typeof errorValue.code === 'string' && (errorValue.code.includes('SQLITE_BUSY') || errorValue.code.includes('SQLITE_LOCKED'))
}

export function registerWebhookRoutes(app: Express, db: Knex, secret: string) {
  app.post('/v1/webhooks/payment', async (request: Request, response: Response) => {
    if (!Buffer.isBuffer(request.body)) return error(response, 400, 'invalid_json', 'Webhook body must be JSON')
    const rawBody = request.body as Buffer
    const signature = request.header('x-provider-signature') ?? ''
    const supplied = /^sha256=([a-f0-9]{64})$/.exec(signature)?.[1]
    const expected = createHmac('sha256', secret).update(rawBody).digest()
    const actual = supplied ? Buffer.from(supplied, 'hex') : Buffer.alloc(0)
    const authenticated = actual.length === expected.length && timingSafeEqual(actual, expected)
    const bodyHash = createHash('sha256').update(rawBody).digest('hex')
    if (!authenticated) {
      try { await recordInvalidWebhook(db, bodyHash) }
      catch (incidentError) {
        logger.error({ request_id: currentRequestId(), failure: busy(incidentError) ? 'database_busy' : 'incident_write_failed' }, 'invalid webhook incident could not be recorded')
      }
      logger.warn({ request_id: currentRequestId(), body_hash: bodyHash }, 'provider webhook signature rejected')
      return error(response, 401, 'invalid_signature', 'Provider webhook signature is invalid')
    }
    let decoded: unknown
    try { decoded = JSON.parse(rawBody.toString('utf8')) }
    catch { return error(response, 400, 'invalid_json', 'Webhook body must contain valid JSON') }
    const body = parseBody(decoded)
    if (!body) return error(response, 400, 'invalid_webhook', 'Webhook body does not match the payment event contract')

    try {
      const outcome = await applyPaymentEvidence(db, {
        source: 'webhook', eventId: body.event_id, evidenceHash: bodyHash, reference: body.reference,
        status: body.status, amount: body.amount, currency: body.currency,
        ...(body.provider_reference ? { providerReference: body.provider_reference } : {}),
      })
      if (outcome === 'mismatch' || outcome === 'not_found') return error(response, 422, 'payment_evidence_mismatch', 'Signed provider evidence does not match a local payment')
      if (outcome === 'conflict') return error(response, 409, 'event_id_conflict', 'Provider event ID was already used with different content')
      response.status(200).json({ data: { accepted: true, outcome } })
    } catch (caught) {
      if (busy(caught)) return error(response, 503, 'temporary_processing_failure', 'Payment event could not be durably processed; retry later')
      throw caught
    }
  })
}
