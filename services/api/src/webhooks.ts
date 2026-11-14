import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import type { Knex } from 'knex'
import { currentRequestId, logger } from './logging.js'
import { applyPaymentEvidence, recordInvalidWebhook, type TerminalPaymentStatus } from './payment-transitions.js'
import { validate, webhookSignatureValidator, webhookValidator } from './validation.js'
import type { PaymentEventHub } from './payment-events.js'

function error(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message, request_id: currentRequestId() } })
}

function busy(errorValue: unknown) {
  return typeof errorValue === 'object' && errorValue !== null && 'code' in errorValue &&
    typeof errorValue.code === 'string' && (errorValue.code.includes('SQLITE_BUSY') || errorValue.code.includes('SQLITE_LOCKED'))
}

export function registerWebhookRoutes(app: Express, db: Knex, secret: string, eventHub?: PaymentEventHub) {
  app.post('/v1/webhooks/payment', async (request: Request, response: Response) => {
    if (!Buffer.isBuffer(request.body)) return error(response, 400, 'invalid_json', 'Webhook body must be JSON')
    const rawBody = request.body as Buffer
    const signature = request.header('x-provider-signature') ?? ''
    let supplied: string | undefined
    try { supplied = (await validate<{ signature: string }>(webhookSignatureValidator, { signature })).signature.slice('sha256='.length) }
    catch { supplied = undefined }
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
    let body: {
      event_id: string; event_type: string; status: TerminalPaymentStatus; reference: string;
      provider_reference?: string; amount: number; currency: string; occurred_at?: string;
    }
    try {
      body = await validate(webhookValidator, decoded, 'invalid_webhook', 'Webhook body does not match the payment event contract')
    } catch (validationError) {
      if (validationError instanceof Error && 'status' in validationError && validationError.status === 400) {
        return error(response, 400, 'invalid_webhook', 'Webhook body does not match the payment event contract')
      }
      throw validationError
    }

    try {
      const outcome = await applyPaymentEvidence(db, {
        source: 'webhook', eventId: body.event_id, evidenceHash: bodyHash, reference: body.reference,
        status: body.status, amount: body.amount, currency: body.currency,
        ...(body.provider_reference ? { providerReference: body.provider_reference } : {}),
      }, eventHub)
      if (outcome === 'mismatch' || outcome === 'not_found') return error(response, 422, 'payment_evidence_mismatch', 'Signed provider evidence does not match a local payment')
      if (outcome === 'conflict') return error(response, 409, 'event_id_conflict', 'Provider event ID was already used with different content')
      response.status(200).json({ data: { accepted: true, outcome } })
    } catch (caught) {
      if (busy(caught)) return error(response, 503, 'temporary_processing_failure', 'Payment event could not be durably processed; retry later')
      throw caught
    }
  })
}
