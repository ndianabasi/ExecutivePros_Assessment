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
  user_id: number
  reference: string
  amount_minor: number
  currency: string
  checkout_expires_at: string
  reconcile_attempts: number
  claim_token: string
  history_id: number
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
      const due = await tx.query<Omit<Candidate, 'claim_token' | 'history_id'>>(
        `SELECT id, user_id, reference, amount_minor, currency, checkout_expires_at, reconcile_attempts
         FROM payments WHERE status = 'pending'
           AND (reconcile_after IS NULL OR reconcile_after <= :now OR checkout_expires_at <= :now)
           AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= :now)
         ORDER BY CASE WHEN checkout_expires_at <= :now THEN 0 ELSE 1 END, reconcile_after, id LIMIT :limit`,
        { now: nowText, limit: config.jobBatchSize },
      )
      const claimed: Candidate[] = []
      for (const candidate of due) {
        const token = randomUUID()
        const rows = await tx.query<{ id: number; reconcile_attempts: number }>(
          `UPDATE payments SET reconcile_claim_token = :token, reconcile_lease_until = :lease,
             reconcile_attempts = reconcile_attempts + 1
           WHERE id = :id AND status = 'pending' AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= :now)
           RETURNING id, reconcile_attempts`,
          { token, lease: leaseUntil, id: candidate.id, now: nowText },
        )
        if (rows.length) {
          const attemptNumber = Number(rows[0]!.reconcile_attempts)
          const history = await tx.query<{ id: number }>(
            `INSERT INTO payment_reconciliation_attempts(payment_id, attempt_number, started_at)
             VALUES (:payment_id, :attempt_number, :started_at) RETURNING id`,
            { payment_id: candidate.id, attempt_number: attemptNumber, started_at: nowText },
          )
          claimed.push({ ...candidate, id: Number(candidate.id), reconcile_attempts: attemptNumber, claim_token: token, history_id: Number(history[0]!.id) })
        }
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

  async function finishAttempt(candidate: Candidate, now: Date, outcome: string, details: string, providerStatus?: string) {
    const changed = await immediate(db, (tx) => tx.query<{ id: number }>(
      `UPDATE payment_reconciliation_attempts
       SET outcome = :outcome, redacted_details = :details, provider_status = :provider_status, completed_at = :completed_at
       WHERE id = :id AND outcome = 'in_progress' RETURNING id`,
      { outcome, details, provider_status: providerStatus ?? null, completed_at: now.toISOString(), id: candidate.history_id },
    ), config.sqliteLockAttempts)
    if (changed.length) eventHub?.publish(candidate.user_id, {
      type: 'reconciliation_completed', payment_id: candidate.id, reference: candidate.reference,
      title: 'Provider Reconciliation Completed',
      message: `Provider status lookup attempt ${candidate.reconcile_attempts} completed: ${outcome.replaceAll('_', ' ')}. ${details}`,
      source: 'reconciliation', attempt_number: candidate.reconcile_attempts,
      ...(providerStatus && ['pending', 'success', 'failed', 'cancelled'].includes(providerStatus) ? { status: providerStatus as 'pending' | 'success' | 'failed' | 'cancelled' } : {}),
      occurred_at: now.toISOString(),
    })
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
        await finishAttempt(candidate, now, 'amount_currency_mismatch', 'Provider lookup amount or currency did not match the stored payment.', payment.status)
        await schedule(candidate, now)
        return
      }
    } catch (error) {
      const details = error instanceof ProviderError && error.status === 404
        ? 'Provider has no status record for this payment yet.'
        : error instanceof ProviderError && error.status !== undefined
          ? `Provider status lookup returned HTTP ${error.status}.`
          : 'Provider status lookup failed or timed out.'
      await finishAttempt(candidate, now, 'provider_lookup_failed', details)
      if (Date.parse(candidate.checkout_expires_at) <= now.getTime()) {
        await recordExpiryLookupFailure(candidate, now, error)
      } else {
        await schedule(candidate, now, error)
      }
      return
    }

    if (payment.status !== 'pending') {
      const transition = await applyPaymentEvidence(db, {
        source: 'reconciliation', evidenceHash: evidenceHash(payment), reference: candidate.reference,
        status: payment.status as TerminalPaymentStatus, amount: payment.amount, currency: payment.currency,
        ...(payment.provider_reference ? { providerReference: payment.provider_reference } : {}),
      }, eventHub)
      const outcome = transition === 'processed' ? `provider_${payment.status}_reconciled` : `provider_${payment.status}_${transition}`
      await finishAttempt(candidate, now, outcome, transition === 'processed'
        ? `Provider status ${payment.status} was verified and applied.`
        : `Provider status ${payment.status} was received; API transition outcome: ${transition}.`, payment.status)
      await immediate(db, async (tx) => {
        await tx.query('UPDATE payments SET reconcile_claim_token = NULL, reconcile_lease_until = NULL WHERE id = :id AND reconcile_claim_token = :token',
          { id: candidate.id, token: candidate.claim_token })
      }, config.sqliteLockAttempts)
      return
    }

    if (Date.parse(candidate.checkout_expires_at) <= now.getTime()) {
      const expired = await expirePendingPayment(db, { paymentId: candidate.id, reference: candidate.reference,
        amount: payment.amount, currency: payment.currency, evidenceHash: evidenceHash(payment) }, eventHub)
      const currentPayment = await db('payments').select('status').where({ id: candidate.id }).first<{ status: string }>()
      const attemptOutcome = expired ? 'provider_pending_expired' : currentPayment?.status !== 'pending' ? 'payment_already_terminal' : 'provider_pending_review'
      const attemptDetails = expired
        ? 'Provider still reported pending at checkout expiry; API payment was failed and reserved stock released.'
        : currentPayment?.status !== 'pending'
          ? `Provider still reported pending, but API payment was already ${currentPayment?.status}; no transition was applied.`
          : 'Provider still reported pending at checkout expiry, but the API payment needs review.'
      await finishAttempt(candidate, now, attemptOutcome, attemptDetails, payment.status)
      await immediate(db, async (tx) => {
        await tx.query('UPDATE payments SET reconcile_claim_token = NULL, reconcile_lease_until = NULL WHERE id = :id AND reconcile_claim_token = :token',
          { id: candidate.id, token: candidate.claim_token })
      }, config.sqliteLockAttempts)
      return
    }
    await finishAttempt(candidate, now, 'provider_still_pending', 'Provider still reports pending before checkout expiry.', payment.status)
    await schedule(candidate, now)
  }

  async function runDue(now = new Date()): Promise<void> {
    if (active) return active
    active = (async () => {
      const candidates = await claim(now)
      for (const candidate of candidates) eventHub?.publish(candidate.user_id, {
        type: 'reconciliation_started', payment_id: candidate.id, reference: candidate.reference,
        title: 'Provider Reconciliation Started',
        message: `Provider status lookup attempt ${candidate.reconcile_attempts} started.`,
        source: 'reconciliation', attempt_number: candidate.reconcile_attempts, status: 'pending', occurred_at: now.toISOString(),
      })
      await Promise.all(candidates.map((candidate) => process(candidate, now).catch(async (error) => {
        logger.error({ payment_reference: candidate.reference, error_type: error instanceof Error ? error.name : 'unknown' }, 'payment reconciliation processing failed')
        await finishAttempt(candidate, now, 'reconciliation_processing_failed', 'API could not complete this reconciliation attempt.')
        await schedule(candidate, now, error)
      })))
    })()
    try { await active } finally { active = undefined }
  }

  return { runDue, async close() { if (active) await active } }
}
