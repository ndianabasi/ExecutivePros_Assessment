import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { ApiConfig } from './config.js'
import { logger } from './logging.js'
import type { PaymentEventHub } from './payment-events.js'
import { ProviderClient, ProviderError } from './provider.js'
import { applyPaymentEvidence, expirePendingPayment, type TerminalPaymentStatus } from './payment-transitions.js'
import { immediate } from './sqlite.js'

interface Candidate {
  id: number
  reference: string
  amount_minor: number
  currency: string
  checkout_expires_at: string
  reconcile_attempts: number
  claim_token: string
}

function retryDelay(attempt: number, testMode: boolean): number {
  const base = Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(attempt - 1, 12))
  return Math.floor(base * (testMode ? 1 : 0.75 + Math.random() * 0.5))
}

function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createPaymentReconciler(db: Knex, provider: ProviderClient, config: ApiConfig, eventHub?: PaymentEventHub) {
  let active: Promise<void> | undefined

  async function claim(now: Date): Promise<Candidate[]> {
    const nowText = now.toISOString()
    const leaseUntil = new Date(now.getTime() + config.providerTimeoutMs + 5000).toISOString()
    return immediate(db, async (tx) => {
      const due = await tx.query<Omit<Candidate, 'claim_token'>>(
        `SELECT id, reference, amount_minor, currency, checkout_expires_at, reconcile_attempts
         FROM payments WHERE status = 'pending'
           AND (reconcile_after IS NULL OR reconcile_after <= :now OR checkout_expires_at <= :now)
           AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= :now)
         ORDER BY CASE WHEN checkout_expires_at <= :now THEN 0 ELSE 1 END, reconcile_after, id LIMIT :limit`,
        { now: nowText, limit: config.jobBatchSize },
      )
      const claimed: Candidate[] = []
      for (const candidate of due) {
        const token = randomUUID()
        const rows = await tx.query<{ id: number }>(
          `UPDATE payments SET reconcile_claim_token = :token, reconcile_lease_until = :lease,
             reconcile_attempts = reconcile_attempts + 1
           WHERE id = :id AND status = 'pending' AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= :now)
           RETURNING id`,
          { token, lease: leaseUntil, id: candidate.id, now: nowText },
        )
        if (rows.length) claimed.push({ ...candidate, id: Number(candidate.id), reconcile_attempts: Number(candidate.reconcile_attempts) + 1, claim_token: token })
      }
      return claimed
    }, config.sqliteLockAttempts)
  }

  async function schedule(candidate: Candidate, now: Date, error?: unknown) {
    const nextAt = new Date(now.getTime() + retryDelay(candidate.reconcile_attempts, config.nodeEnv === 'test')).toISOString()
    await immediate(db, async (tx) => {
      await tx.query(
        `UPDATE payments SET reconcile_after = :next, reconcile_claim_token = NULL, reconcile_lease_until = NULL,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = :id AND status = 'pending' AND reconcile_claim_token = :token`,
        { next: nextAt, id: candidate.id, token: candidate.claim_token },
      )
    }, config.sqliteLockAttempts)
    if (error) logger.warn({ payment_reference: candidate.reference, attempt: candidate.reconcile_attempts,
      error_type: error instanceof Error ? error.name : 'unknown' }, 'provider payment reconciliation lookup failed')
  }

  async function recordExpiryLookupFailure(candidate: Candidate, now: Date, error: unknown) {
    await immediate(db, async (tx) => {
      const detail = error instanceof ProviderError && error.status === 404
        ? 'Provider has no status record for an expired API payment; payment remains pending pending provider confirmation'
        : 'Provider status could not be confirmed for an expired API payment; payment remains pending'
      const incidentId = `expiry_lookup_unavailable:${candidate.id}`
      const incidents = await tx.query<{ id: number }>(
        `INSERT INTO payment_incidents(dedupe_key, payment_id, reference, code, redacted_details)
         VALUES (:dedupe, :payment_id, :reference, 'expired_payment_status_unavailable', :details)
         ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        { dedupe: incidentId, payment_id: candidate.id, reference: candidate.reference, details: detail },
      )
      if (incidents.length) {
        const admins = await tx.query<{ email: string }>("SELECT email FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id")
        for (const admin of admins) {
          const notificationKey = `incident:${incidentId}:${admin.email}`
          const payload = JSON.stringify({ type: 'email', notification_key: notificationKey, to: admin.email,
            subject: 'Payment expiry requires provider review', text: `${detail}. Reference: ${candidate.reference}`,
            payment_reference: candidate.reference })
          await tx.query(
            `INSERT INTO notification_outbox(queue_job_key, notification_type, recipient, payload)
             VALUES (:key, 'admin_incident', :recipient, :payload) ON CONFLICT(queue_job_key) DO NOTHING`,
            { key: notificationKey, recipient: admin.email, payload },
          )
        }
      }
    }, config.sqliteLockAttempts)
    await schedule(candidate, now, error)
    logger.error({ payment_reference: candidate.reference, expired_at: candidate.checkout_expires_at,
      error_type: error instanceof Error ? error.name : 'unknown' }, 'expired pending payment is awaiting provider confirmation')
  }

  async function process(candidate: Candidate, now: Date) {
    let payment
    try {
      payment = await provider.lookup(candidate.reference)
      if (payment.amount !== Number(candidate.amount_minor) || payment.currency !== candidate.currency) {
        await applyPaymentEvidence(db, {
          source: 'reconciliation', evidenceHash: evidenceHash(payment), reference: candidate.reference,
          status: payment.status === 'pending' ? 'failed' : payment.status,
          amount: payment.amount, currency: payment.currency,
          ...(payment.provider_reference ? { providerReference: payment.provider_reference } : {}),
        }, eventHub)
        await schedule(candidate, now)
        return
      }
    } catch (error) {
      if (Date.parse(candidate.checkout_expires_at) <= now.getTime()) {
        await recordExpiryLookupFailure(candidate, now, error)
      } else {
        await schedule(candidate, now, error)
      }
      return
    }

    if (payment.status !== 'pending') {
      await applyPaymentEvidence(db, {
        source: 'reconciliation', evidenceHash: evidenceHash(payment), reference: candidate.reference,
        status: payment.status as TerminalPaymentStatus, amount: payment.amount, currency: payment.currency,
        ...(payment.provider_reference ? { providerReference: payment.provider_reference } : {}),
      }, eventHub)
      await immediate(db, async (tx) => {
        await tx.query('UPDATE payments SET reconcile_claim_token = NULL, reconcile_lease_until = NULL WHERE id = :id AND reconcile_claim_token = :token',
          { id: candidate.id, token: candidate.claim_token })
      }, config.sqliteLockAttempts)
      return
    }

    if (Date.parse(candidate.checkout_expires_at) <= now.getTime()) {
      await expirePendingPayment(db, { paymentId: candidate.id, reference: candidate.reference,
        amount: payment.amount, currency: payment.currency, evidenceHash: evidenceHash(payment) }, eventHub)
      await immediate(db, async (tx) => {
        await tx.query('UPDATE payments SET reconcile_claim_token = NULL, reconcile_lease_until = NULL WHERE id = :id AND reconcile_claim_token = :token',
          { id: candidate.id, token: candidate.claim_token })
      }, config.sqliteLockAttempts)
      return
    }
    await schedule(candidate, now)
  }

  async function runDue(now = new Date()): Promise<void> {
    if (active) return active
    active = (async () => {
      const candidates = await claim(now)
      await Promise.all(candidates.map((candidate) => process(candidate, now).catch(async (error) => {
        logger.error({ payment_reference: candidate.reference, error_type: error instanceof Error ? error.name : 'unknown' }, 'payment reconciliation processing failed')
        await schedule(candidate, now, error)
      })))
    })()
    try { await active } finally { active = undefined }
  }

  return { runDue, async close() { if (active) await active } }
}
