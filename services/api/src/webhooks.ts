import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import type { Knex } from 'knex'
import { currentRequestId, logger } from './logging.js'
import { applyPaymentEvidence, recordInvalidWebhook, type TerminalPaymentStatus } from './payment-transitions.js'
import { validate, webhookReferenceValidator, webhookSignatureValidator, webhookValidator } from './validation.js'
import type { PaymentEventHub } from './payment-events.js'
import type { PaymentActivityTarget } from './payment-events.js'

function error(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message, request_id: currentRequestId() } })
}

function busy(errorValue: unknown) {
  return typeof errorValue === 'object' && errorValue !== null && 'code' in errorValue &&
    typeof errorValue.code === 'string' && (errorValue.code.includes('SQLITE_BUSY') || errorValue.code.includes('SQLITE_LOCKED'))
}

async function findPaymentTarget(db: Knex, reference: string): Promise<PaymentActivityTarget | undefined> {
  const payment = (await db.raw('SELECT id, user_id, reference FROM payments WHERE reference = :reference', { reference }) as Array<Record<string, unknown>>)[0]
  return payment ? { payment_id: Number(payment.id), user_id: Number(payment.user_id), reference: String(payment.reference) } : undefined
}

function publishWebhookActivity(hub: PaymentEventHub | undefined, target: PaymentActivityTarget, type: 'webhook_received' | 'webhook_verification_succeeded' | 'webhook_verification_failed' | 'webhook_result', title: string, message: string) {
  hub?.publish(target.user_id, {
    type, payment_id: target.payment_id, reference: target.reference, title, message, source: 'webhook',
    request_id: currentRequestId() ?? 'unknown',
  })
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
      let unverifiedReference: string | undefined
      try {
        const candidate: unknown = JSON.parse(rawBody.toString('utf8'))
        if (typeof candidate === 'object' && candidate !== null && 'reference' in candidate) {
          unverifiedReference = (await validate<{ reference: string }>(webhookReferenceValidator, { reference: candidate.reference })).reference
        }
      } catch { /* Invalid signatures are recorded even when their body cannot be correlated. */ }
      let target: PaymentActivityTarget | undefined
      try { target = await recordInvalidWebhook(db, bodyHash, unverifiedReference) }
      catch (incidentError) {
        logger.error({ request_id: currentRequestId(), failure: busy(incidentError) ? 'database_busy' : 'incident_write_failed' }, 'invalid webhook incident could not be recorded')
      }
      if (target) {
        publishWebhookActivity(eventHub, target, 'webhook_received', 'Provider Webhook Received', 'A provider update was received for this payment.')
        publishWebhookActivity(eventHub, target, 'webhook_verification_failed', 'Webhook Verification Failed', 'The provider webhook signature could not be verified. No payment data was applied.')
      }
      logger.warn({ request_id: currentRequestId(), body_hash: bodyHash }, 'provider webhook signature rejected')
      return error(response, 401, 'invalid_signature', 'Provider webhook signature is invalid')
    }
    let decoded: unknown
    try { decoded = JSON.parse(rawBody.toString('utf8')) }
    catch { return error(response, 400, 'invalid_json', 'Webhook body must contain valid JSON') }
    let target: PaymentActivityTarget | undefined
    if (typeof decoded === 'object' && decoded !== null && 'reference' in decoded) {
      try {
        const candidate = await validate<{ reference: string }>(webhookReferenceValidator, { reference: decoded.reference })
        target = await findPaymentTarget(db, candidate.reference)
      } catch { /* A signed but malformed event can still be rejected without a payment notification. */ }
    }
    if (target) {
      publishWebhookActivity(eventHub, target, 'webhook_received', 'Provider Webhook Received', 'A provider update was received for this payment.')
      publishWebhookActivity(eventHub, target, 'webhook_verification_succeeded', 'Webhook Verified', 'The provider webhook signature was verified.')
    }
    let body: {
      event_id: string; event_type: string; status: TerminalPaymentStatus; reference: string;
      provider_reference?: string; amount: number; currency: string; occurred_at?: string;
    }
    try {
      body = await validate(webhookValidator, decoded, 'invalid_webhook', 'Webhook body does not match the payment event contract')
    } catch (validationError) {
      if (validationError instanceof Error && 'status' in validationError && validationError.status === 400) {
        if (target) publishWebhookActivity(eventHub, target, 'webhook_result', 'Webhook Rejected', 'The signed provider webhook did not match the payment event contract.')
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
      logger.info({ request_id: currentRequestId(), payment_reference: body.reference, provider_event_id: body.event_id,
        webhook_outcome: outcome }, 'provider webhook processed')
      if (target) {
        const result: [string, string] = outcome === 'mismatch'
          ? ['Webhook Evidence Mismatch', 'The signed provider amount or currency did not match this payment.']
          : outcome === 'terminal_conflict' || outcome === 'late_success'
            ? ['Webhook Conflict Recorded', 'The provider update conflicts with the terminal payment state and was not applied.']
            : outcome === 'duplicate'
              ? ['Duplicate Webhook Ignored', 'This provider webhook was already processed.']
              : outcome === 'processed'
                ? ['Webhook Processed', 'The verified provider update was processed.']
                : ['Webhook Not Applied', 'The signed provider update did not match a local payment.']
        publishWebhookActivity(eventHub, target, 'webhook_result', result[0], result[1])
      }
      if (outcome === 'mismatch' || outcome === 'not_found') return error(response, 422, 'payment_evidence_mismatch', 'Signed provider evidence does not match a local payment')
      if (outcome === 'conflict') return error(response, 409, 'event_id_conflict', 'Provider event ID was already used with different content')
      response.status(200).json({ data: { accepted: true, outcome } })
    } catch (caught) {
      if (busy(caught)) return error(response, 503, 'temporary_processing_failure', 'Payment event could not be durably processed; retry later')
      throw caught
    }
  })
}
