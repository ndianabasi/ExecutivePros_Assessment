import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { immediate, type SqliteTransaction } from './sqlite.js'
import { currentRequestId, logger } from './logging.js'
import type { PaymentActivityDraft, PaymentActivityTarget, PaymentEventHub } from './payment-events.js'

export type TerminalPaymentStatus = 'success' | 'failed' | 'cancelled'
export interface PaymentEvidence {
  source: 'webhook' | 'reconciliation'
  eventId?: string
  evidenceHash: string
  reference: string
  status: TerminalPaymentStatus
  amount: number
  currency: string
  providerReference?: string
}
export type TransitionResult =
  'processed' | 'duplicate' | 'conflict' | 'terminal_conflict' | 'mismatch' | 'not_found' | 'late_success'

/**
 * Builds a stable notification key from the supplied payment, outcome, and recipient values.
 *
 * @param parts - Canonical payment fingerprint components used to detect conflicting idempotent requests.
 */
function key(...parts: string[]) {
  return `notify_${createHash('sha256').update(parts.join('|')).digest('hex')}`
}

/**
 * Escapes HTML metacharacters before a value is inserted into provider-rendered markup.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 */
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!
  })
}

/**
 * Persists a deduplicated payment integrity incident and its admin notification intents atomically.
 *
 * @param tx - Active SQLite transaction used to keep related database changes atomic.
 * @param input - Validated request data used to perform the operation.
 */
async function createIncident(
  tx: SqliteTransaction,
  input: { dedupeKey: string; paymentId?: number; reference?: string; code: string; details: string },
) {
  const rows = await tx.query<{ id: number }>(
    `INSERT INTO payment_incidents(dedupe_key, payment_id, reference, code, redacted_details)
     VALUES (:dedupe_key, :payment_id, :reference, :code, :details)
     ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    {
      dedupe_key: input.dedupeKey,
      payment_id: input.paymentId ?? null,
      reference: input.reference ?? null,
      code: input.code,
      details: input.details,
    },
  )
  const incident =
    rows[0] ??
    (
      await tx.query<{ id: number }>('SELECT id FROM payment_incidents WHERE dedupe_key = :key', {
        key: input.dedupeKey,
      })
    )[0]
  if (!incident) {
    throw new Error('Incident insert returned no ID')
  }
  const admins = await tx.query<{ email: string }>(
    "SELECT email FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id",
  )
  for (const admin of admins) {
    const notificationKey = key(`incident:${incident.id}`, 'admin_incident', admin.email)
    const payload = JSON.stringify({
      type: 'email',
      notification_key: notificationKey,
      to: admin.email,
      subject: `Payment integrity incident: ${input.code}`,
      text: `${input.code}: ${input.details}${input.reference ? ` Reference: ${input.reference}` : ''}`,
      payment_reference: input.reference ?? undefined,
    })
    await tx.query(
      `INSERT INTO notification_outbox(queue_job_key, notification_type, recipient, payload)
       VALUES (:key, 'admin_incident', :recipient, :payload) ON CONFLICT(queue_job_key) DO NOTHING`,
      { key: notificationKey, recipient: admin.email, payload },
    )
  }
}

/**
 * Persists the user email intent for a terminal payment outcome inside the payment transaction.
 *
 * @param tx - Active SQLite transaction used to keep related database changes atomic.
 * @param payment - Stored payment record whose provider state or public response is being handled.
 * @param status - Validated state used to determine the permitted transition.
 */
async function createUserNotification(
  tx: SqliteTransaction,
  payment: {
    id: number
    user_id: number
    reference: string
    amount_minor: number
    currency: string
  },
  status: TerminalPaymentStatus,
) {
  const user = (
    await tx.query<{ email: string; first_name: string }>(
      'SELECT email, first_name FROM users WHERE id = :id',
      { id: payment.user_id },
    )
  )[0]
  if (!user) {
    throw new Error('Payment user does not exist')
  }
  const label = status === 'success' ? 'successful' : status
  const notificationKey = key(payment.reference, `payment_${status}`, user.email)
  const amount = (Number(payment.amount_minor) / 100).toFixed(2)
  const text = `Hello ${user.first_name}, your payment ${payment.reference} is ${label}. Amount: ${amount} ${payment.currency}.`
  const payload = JSON.stringify({
    type: 'email',
    notification_key: notificationKey,
    to: user.email,
    subject: `Payment ${label}`,
    text,
    html: `<p>Hello ${escapeHtml(user.first_name)},</p><p>Your payment <strong>${escapeHtml(payment.reference)}</strong> is ${label}.</p><p>Amount: ${amount} ${escapeHtml(payment.currency)}.</p>`,
    payment_reference: payment.reference,
  })
  await tx.query(
    `INSERT INTO notification_outbox(queue_job_key, notification_type, recipient, payload)
     VALUES (:key, :type, :recipient, :payload) ON CONFLICT(queue_job_key) DO NOTHING`,
    { key: notificationKey, type: `payment_${status}`, recipient: user.email, payload },
  )
}

/**
 * Stores provider evidence and the outcome associated with a payment transition.
 *
 * @param tx - Active SQLite transaction used to keep related database changes atomic.
 * @param evidence - Provider-signed or provider-looked-up evidence being validated against the stored payment.
 * @param paymentId - API-owned payment record identifier used to scope the operation.
 * @param outcome - Recorded payment or delivery result used to choose notifications and retry behavior.
 */
async function insertEvidence(
  tx: SqliteTransaction,
  evidence: PaymentEvidence,
  paymentId: number | null,
  outcome: string,
) {
  await tx.query(
    `INSERT INTO provider_events(source, event_id, evidence_hash, reference, payment_id, outcome)
     VALUES (:source, :event_id, :hash, :reference, :payment_id, :outcome)`,
    {
      source: evidence.source,
      event_id: evidence.eventId ?? null,
      hash: evidence.evidenceHash,
      reference: evidence.reference,
      payment_id: paymentId,
      outcome,
    },
  )
}

/**
 * Validates provider evidence and atomically applies a permitted terminal payment transition.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param evidence - Provider-signed or provider-looked-up evidence being validated against the stored payment.
 * @param eventHub - Owner-scoped activity hub used to notify connected payment clients after state changes.
 *
 * @returns The transition outcome, including processed, duplicate, mismatch, conflict, or not-found.
 */
export async function applyPaymentEvidence(
  db: Knex,
  evidence: PaymentEvidence,
  eventHub?: PaymentEventHub,
): Promise<TransitionResult> {
  let committedEvent: PaymentActivityDraft | undefined
  let committedUserId: number | undefined
  const outcome = await immediate(db, async (tx) => {
    if (evidence.eventId) {
      const existing = (
        await tx.query<{ evidence_hash: string }>(
          'SELECT evidence_hash FROM provider_events WHERE event_id = :id',
          { id: evidence.eventId },
        )
      )[0]
      if (existing) {
        return existing.evidence_hash === evidence.evidenceHash ? 'duplicate' : 'conflict'
      }
    }
    const payment = (
      await tx.query<{
        id: number
        user_id: number
        cart_id: number
        reference: string
        status: string
        amount_minor: number
        currency: string
      }>(
        'SELECT id, user_id, cart_id, reference, status, amount_minor, currency FROM payments WHERE reference = :reference',
        { reference: evidence.reference },
      )
    )[0]
    if (!payment) {
      await insertEvidence(tx, evidence, null, 'unknown_reference')
      await createIncident(tx, {
        dedupeKey: `unknown_reference:${evidence.reference}:${evidence.evidenceHash}`,
        reference: evidence.reference,
        code: 'unknown_payment_reference',
        details: 'Signed provider evidence references no local payment',
      })
      return 'not_found'
    }
    if (Number(payment.amount_minor) !== evidence.amount || payment.currency !== evidence.currency) {
      await insertEvidence(tx, evidence, Number(payment.id), 'amount_currency_mismatch')
      await createIncident(tx, {
        dedupeKey: `mismatch:${payment.id}:${evidence.evidenceHash}`,
        paymentId: Number(payment.id),
        reference: payment.reference,
        code: 'provider_amount_currency_mismatch',
        details: 'Signed provider evidence did not match the stored amount or currency',
      })
      return 'mismatch'
    }
    if (payment.status !== 'pending') {
      await insertEvidence(
        tx,
        evidence,
        Number(payment.id),
        `terminal_conflict:${payment.status}->${evidence.status}`,
      )
      if (payment.status === 'failed' && evidence.status === 'success') {
        await createIncident(tx, {
          dedupeKey: `late_success:${payment.id}`,
          paymentId: Number(payment.id),
          reference: payment.reference,
          code: 'late_provider_success',
          details:
            'Provider reported success after the API payment failure became terminal; manual resolution is required',
        })
        return 'late_success'
      }
      if (payment.status !== evidence.status) {
        await createIncident(tx, {
          dedupeKey: `terminal_conflict:${payment.id}:${evidence.status}`,
          paymentId: Number(payment.id),
          reference: payment.reference,
          code: 'conflicting_terminal_provider_event',
          details: `Provider reported ${evidence.status} after API status ${payment.status}`,
        })
        return 'terminal_conflict'
      }
      return 'duplicate'
    }

    await insertEvidence(tx, evidence, Number(payment.id), evidence.status)
    const changed = await tx.query<{ id: number }>(
      `UPDATE payments SET status = :status, provider_transaction_reference = :provider_reference,
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = :id AND status = 'pending' RETURNING id`,
      { status: evidence.status, provider_reference: evidence.providerReference ?? null, id: payment.id },
    )
    if (changed.length !== 1) {
      throw new Error('Payment terminal transition lost its conditional update')
    }

    if (evidence.status === 'success') {
      const reservationRows = await tx.query<{ product_id: number; quantity: number }>(
        "SELECT product_id, quantity FROM stock_reservations WHERE payment_id = :id AND status = 'active' ORDER BY product_id",
        { id: payment.id },
      )
      if (reservationRows.length === 0) {
        throw new Error('Successful payment has no active stock reservations')
      }
      const fulfillment = (
        await tx.query<{ id: number }>(
          'INSERT INTO fulfillments(user_id, payment_id, cart_id) VALUES (:user_id, :payment_id, :cart_id) RETURNING id',
          { user_id: payment.user_id, payment_id: payment.id, cart_id: payment.cart_id },
        )
      )[0]
      if (!fulfillment) {
        throw new Error('Fulfillment insert returned no ID')
      }
      const snapshots = await tx.query<{
        product_id: number
        product_name: string
        quantity: number
        unit_price_minor: number
        currency: string
        line_total_minor: number
      }>(
        `SELECT product_id, product_name, quantity, unit_price_minor, currency, line_total_minor
         FROM cart_items WHERE cart_id = :cart_id ORDER BY product_id`,
        { cart_id: payment.cart_id },
      )
      if (snapshots.length !== reservationRows.length) {
        throw new Error('Fulfillment snapshot and reservation set differ')
      }
      for (const item of snapshots) {
        const decremented = await tx.query<{ id: number }>(
          'UPDATE products SET stock_quantity = stock_quantity - :quantity WHERE id = :id AND stock_quantity >= :quantity RETURNING id',
          { id: item.product_id, quantity: item.quantity },
        )
        if (decremented.length !== 1) {
          throw new Error('Reserved stock could not be consumed')
        }
        await tx.query(
          `INSERT INTO fulfillment_items(fulfillment_id, product_id, product_name, quantity, unit_price_minor, currency, line_total_minor)
           VALUES (:fulfillment_id, :product_id, :name, :quantity, :price, :currency, :total)`,
          {
            fulfillment_id: fulfillment.id,
            product_id: item.product_id,
            name: item.product_name,
            quantity: item.quantity,
            price: item.unit_price_minor,
            currency: item.currency,
            total: item.line_total_minor,
          },
        )
      }
      await tx.query(
        "UPDATE stock_reservations SET status = 'consumed', updated_at = CURRENT_TIMESTAMP WHERE payment_id = :id AND status = 'active'",
        { id: payment.id },
      )
      await tx.query(
        "UPDATE carts SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND status = 'checked_out'",
        { id: payment.cart_id },
      )
    } else {
      await tx.query(
        "UPDATE stock_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE payment_id = :id AND status = 'active'",
        { id: payment.id },
      )
    }
    await createUserNotification(tx, payment, evidence.status)
    committedEvent = {
      type:
        evidence.status === 'success'
          ? 'payment_succeeded'
          : evidence.status === 'failed'
            ? 'payment_failed'
            : 'payment_cancelled',
      payment_id: Number(payment.id),
      reference: payment.reference,
      status: evidence.status,
      source: evidence.source,
      title:
        evidence.status === 'success'
          ? 'Payment Successful'
          : evidence.status === 'failed'
            ? 'Payment Failed'
            : 'Payment Cancelled',
      message:
        evidence.source === 'webhook'
          ? `A verified provider webhook confirmed payment ${evidence.status}.`
          : `Provider status reconciliation confirmed payment ${evidence.status}.`,
      request_id: currentRequestId() ?? 'unknown',
    }
    committedUserId = Number(payment.user_id)
    logger.info(
      {
        payment_reference: payment.reference,
        payment_status: evidence.status,
        evidence_source: evidence.source,
        provider_event_id: evidence.eventId ?? null,
      },
      'payment transition committed',
    )
    return 'processed'
  })
  if (outcome === 'processed' && committedEvent && committedUserId !== undefined) {
    eventHub?.publish(committedUserId, committedEvent)
  }
  return outcome
}

/**
 * Conditionally fails an expired pending payment and releases its active stock reservation.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param input - Validated request data used to perform the operation.
 * @param eventHub - Owner-scoped activity hub used to notify connected payment clients after state changes.
 *
 * @returns Whether the pending payment changed to failed and its reservation was released.
 */
export async function expirePendingPayment(
  db: Knex,
  input: {
    paymentId: number
    reference: string
    amount: number
    currency: string
    evidenceHash: string
  },
  eventHub?: PaymentEventHub,
): Promise<boolean> {
  let committedEvent: PaymentActivityDraft | undefined
  let committedUserId: number | undefined
  const expired = await immediate(db, async (tx) => {
    const payment = (
      await tx.query<{
        id: number
        user_id: number
        cart_id: number
        reference: string
        status: string
        amount_minor: number
        currency: string
      }>(
        'SELECT id, user_id, cart_id, reference, status, amount_minor, currency FROM payments WHERE id = :id',
        { id: input.paymentId },
      )
    )[0]
    if (!payment || payment.status !== 'pending' || payment.reference !== input.reference) {
      return false
    }
    if (Number(payment.amount_minor) !== input.amount || payment.currency !== input.currency) {
      await insertEvidence(
        tx,
        {
          source: 'reconciliation',
          evidenceHash: input.evidenceHash,
          reference: input.reference,
          status: 'failed',
          amount: input.amount,
          currency: input.currency,
        },
        Number(payment.id),
        'expiry_lookup_mismatch',
      )
      await createIncident(tx, {
        dedupeKey: `expiry_mismatch:${payment.id}`,
        paymentId: Number(payment.id),
        reference: payment.reference,
        code: 'provider_amount_currency_mismatch',
        details: 'Expiry status lookup did not match the stored amount or currency',
      })
      return false
    }
    await insertEvidence(
      tx,
      {
        source: 'reconciliation',
        evidenceHash: input.evidenceHash,
        reference: input.reference,
        status: 'failed',
        amount: input.amount,
        currency: input.currency,
      },
      Number(payment.id),
      'expired_provider_pending',
    )
    const changed = await tx.query<{ id: number }>(
      `UPDATE payments SET status = 'failed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = :id AND status = 'pending' RETURNING id`,
      { id: payment.id },
    )
    if (changed.length !== 1) {
      return false
    }
    await tx.query(
      "UPDATE stock_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE payment_id = :id AND status = 'active'",
      { id: payment.id },
    )
    await createUserNotification(tx, payment, 'failed')
    await createIncident(tx, {
      dedupeKey: `expired_pending:${payment.id}`,
      paymentId: Number(payment.id),
      reference: payment.reference,
      code: 'payment_expired_provider_pending',
      details:
        'Payment reached its checkout expiry while the provider still reported pending; provider cancellation was not confirmed',
    })
    committedEvent = {
      type: 'payment_failed',
      payment_id: Number(payment.id),
      reference: payment.reference,
      status: 'failed',
      source: 'reconciliation',
      title: 'Payment Failed',
      message:
        'The provider still reported pending at checkout expiry. The API marked the payment failed and released reserved stock; provider cancellation was not confirmed.',
      request_id: currentRequestId() ?? 'reconciliation',
    }
    committedUserId = Number(payment.user_id)
    logger.warn(
      { payment_reference: payment.reference, payment_status: 'failed', evidence_source: 'reconciliation' },
      'pending provider payment expired without provider cancellation confirmation',
    )
    return true
  })
  if (expired && committedEvent && committedUserId !== undefined) {
    eventHub?.publish(committedUserId, committedEvent)
  }
  return expired
}

/**
 * Records an invalid-signature incident and safely associates it with a matching local payment.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param bodyHash - SHA-256 digest of the received webhook body used for event deduplication.
 * @param unverifiedReference - Payment reference extracted from an unverified webhook only for safe incident correlation.
 *
 * @returns The matching local payment target when a validated reference could be safely correlated.
 */
export async function recordInvalidWebhook(
  db: Knex,
  bodyHash: string,
  unverifiedReference?: string,
): Promise<PaymentActivityTarget | undefined> {
  return immediate(db, async (tx) => {
    const payment = unverifiedReference
      ? (
          await tx.query<{ id: number; user_id: number; reference: string }>(
            'SELECT id, user_id, reference FROM payments WHERE reference = :reference',
            { reference: unverifiedReference },
          )
        )[0]
      : undefined
    await createIncident(tx, {
      dedupeKey: `invalid_signature:${bodyHash}`,
      ...(payment ? { paymentId: Number(payment.id), reference: payment.reference } : {}),
      code: 'invalid_webhook_signature',
      details: 'A provider webhook failed HMAC authentication; its unverified contents were not applied',
    })
    return payment
      ? { user_id: Number(payment.user_id), payment_id: Number(payment.id), reference: payment.reference }
      : undefined
  })
}
