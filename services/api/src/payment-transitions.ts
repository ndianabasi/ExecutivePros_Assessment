import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { immediate, type SqliteTransaction } from './sqlite.js'
import { currentRequestId, logger } from './logging.js'
import type { PaymentEventHub, PaymentStatusEvent } from './payment-events.js'

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
export type TransitionResult = 'processed' | 'duplicate' | 'conflict' | 'terminal_conflict' | 'mismatch' | 'not_found' | 'late_success'

function key(...parts: string[]) {
  return `notify_${createHash('sha256').update(parts.join('|')).digest('hex')}`
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

async function createIncident(tx: SqliteTransaction, input: { dedupeKey: string; paymentId?: number; reference?: string; code: string; details: string }) {
  const rows = await tx.query<{ id: number }>(
    `INSERT INTO payment_incidents(dedupe_key, payment_id, reference, code, redacted_details)
     VALUES (:dedupe_key, :payment_id, :reference, :code, :details)
     ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    { dedupe_key: input.dedupeKey, payment_id: input.paymentId ?? null, reference: input.reference ?? null, code: input.code, details: input.details },
  )
  const incident = rows[0] ?? (await tx.query<{ id: number }>('SELECT id FROM payment_incidents WHERE dedupe_key = :key', { key: input.dedupeKey }))[0]
  if (!incident) throw new Error('Incident insert returned no ID')
  const admins = await tx.query<{ email: string }>("SELECT email FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id")
  for (const admin of admins) {
    const notificationKey = key(`incident:${incident.id}`, 'admin_incident', admin.email)
    const payload = JSON.stringify({
      type: 'email', notification_key: notificationKey, to: admin.email,
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

async function createUserNotification(tx: SqliteTransaction, payment: {
  id: number; user_id: number; reference: string; amount_minor: number; currency: string;
}, status: TerminalPaymentStatus) {
  const user = (await tx.query<{ email: string; first_name: string }>('SELECT email, first_name FROM users WHERE id = :id', { id: payment.user_id }))[0]
  if (!user) throw new Error('Payment user does not exist')
  const label = status === 'success' ? 'successful' : status
  const notificationKey = key(payment.reference, `payment_${status}`, user.email)
  const amount = (Number(payment.amount_minor) / 100).toFixed(2)
  const text = `Hello ${user.first_name}, your payment ${payment.reference} is ${label}. Amount: ${amount} ${payment.currency}.`
  const payload = JSON.stringify({
    type: 'email', notification_key: notificationKey, to: user.email,
    subject: `Payment ${label}`, text,
    html: `<p>Hello ${escapeHtml(user.first_name)},</p><p>Your payment <strong>${escapeHtml(payment.reference)}</strong> is ${label}.</p><p>Amount: ${amount} ${escapeHtml(payment.currency)}.</p>`,
    payment_reference: payment.reference,
  })
  await tx.query(
    `INSERT INTO notification_outbox(queue_job_key, notification_type, recipient, payload)
     VALUES (:key, :type, :recipient, :payload) ON CONFLICT(queue_job_key) DO NOTHING`,
    { key: notificationKey, type: `payment_${status}`, recipient: user.email, payload },
  )
}

async function insertEvidence(tx: SqliteTransaction, evidence: PaymentEvidence, paymentId: number | null, outcome: string) {
  await tx.query(
    `INSERT INTO provider_events(source, event_id, evidence_hash, reference, payment_id, outcome)
     VALUES (:source, :event_id, :hash, :reference, :payment_id, :outcome)`,
    { source: evidence.source, event_id: evidence.eventId ?? null, hash: evidence.evidenceHash, reference: evidence.reference, payment_id: paymentId, outcome },
  )
}

export async function applyPaymentEvidence(db: Knex, evidence: PaymentEvidence, eventHub?: PaymentEventHub): Promise<TransitionResult> {
  let committedEvent: PaymentStatusEvent | undefined
  let committedUserId: number | undefined
  const outcome = await immediate(db, async (tx) => {
    if (evidence.eventId) {
      const existing = (await tx.query<{ evidence_hash: string }>('SELECT evidence_hash FROM provider_events WHERE event_id = :id', { id: evidence.eventId }))[0]
      if (existing) return existing.evidence_hash === evidence.evidenceHash ? 'duplicate' : 'conflict'
    }
    const payment = (await tx.query<{
      id: number; user_id: number; cart_id: number; reference: string; status: string; amount_minor: number; currency: string;
    }>('SELECT id, user_id, cart_id, reference, status, amount_minor, currency FROM payments WHERE reference = :reference', { reference: evidence.reference }))[0]
    if (!payment) {
      await insertEvidence(tx, evidence, null, 'unknown_reference')
      await createIncident(tx, {
        dedupeKey: `unknown_reference:${evidence.reference}:${evidence.evidenceHash}`,
        reference: evidence.reference, code: 'unknown_payment_reference', details: 'Signed provider evidence references no local payment',
      })
      return 'not_found'
    }
    if (Number(payment.amount_minor) !== evidence.amount || payment.currency !== evidence.currency) {
      await insertEvidence(tx, evidence, Number(payment.id), 'amount_currency_mismatch')
      await createIncident(tx, {
        dedupeKey: `mismatch:${payment.id}:${evidence.evidenceHash}`, paymentId: Number(payment.id), reference: payment.reference,
        code: 'provider_amount_currency_mismatch', details: 'Signed provider evidence did not match the stored amount or currency',
      })
      return 'mismatch'
    }
    if (payment.status !== 'pending') {
      await insertEvidence(tx, evidence, Number(payment.id), `terminal_conflict:${payment.status}->${evidence.status}`)
      if (payment.status === 'failed' && evidence.status === 'success') {
        await createIncident(tx, {
          dedupeKey: `late_success:${payment.id}`, paymentId: Number(payment.id), reference: payment.reference,
          code: 'late_provider_success', details: 'Provider reported success after the API payment failure became terminal; manual resolution is required',
        })
        return 'late_success'
      }
      if (payment.status !== evidence.status) {
        await createIncident(tx, {
          dedupeKey: `terminal_conflict:${payment.id}:${evidence.status}`, paymentId: Number(payment.id), reference: payment.reference,
          code: 'conflicting_terminal_provider_event', details: `Provider reported ${evidence.status} after API status ${payment.status}`,
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
    if (changed.length !== 1) throw new Error('Payment terminal transition lost its conditional update')

    if (evidence.status === 'success') {
      const reservationRows = await tx.query<{ product_id: number; quantity: number }>(
        "SELECT product_id, quantity FROM stock_reservations WHERE payment_id = :id AND status = 'active' ORDER BY product_id", { id: payment.id },
      )
      if (reservationRows.length === 0) throw new Error('Successful payment has no active stock reservations')
      const fulfillment = (await tx.query<{ id: number }>(
        'INSERT INTO fulfillments(user_id, payment_id, cart_id) VALUES (:user_id, :payment_id, :cart_id) RETURNING id',
        { user_id: payment.user_id, payment_id: payment.id, cart_id: payment.cart_id },
      ))[0]
      if (!fulfillment) throw new Error('Fulfillment insert returned no ID')
      const snapshots = await tx.query<{ product_id: number; product_name: string; quantity: number; unit_price_minor: number; currency: string; line_total_minor: number }>(
        `SELECT product_id, product_name, quantity, unit_price_minor, currency, line_total_minor
         FROM cart_items WHERE cart_id = :cart_id ORDER BY product_id`, { cart_id: payment.cart_id },
      )
      if (snapshots.length !== reservationRows.length) throw new Error('Fulfillment snapshot and reservation set differ')
      for (const item of snapshots) {
        const decremented = await tx.query<{ id: number }>(
          'UPDATE products SET stock_quantity = stock_quantity - :quantity WHERE id = :id AND stock_quantity >= :quantity RETURNING id',
          { id: item.product_id, quantity: item.quantity },
        )
        if (decremented.length !== 1) throw new Error('Reserved stock could not be consumed')
        await tx.query(
          `INSERT INTO fulfillment_items(fulfillment_id, product_id, product_name, quantity, unit_price_minor, currency, line_total_minor)
           VALUES (:fulfillment_id, :product_id, :name, :quantity, :price, :currency, :total)`,
          { fulfillment_id: fulfillment.id, product_id: item.product_id, name: item.product_name, quantity: item.quantity, price: item.unit_price_minor, currency: item.currency, total: item.line_total_minor },
        )
      }
      await tx.query("UPDATE stock_reservations SET status = 'consumed', updated_at = CURRENT_TIMESTAMP WHERE payment_id = :id AND status = 'active'", { id: payment.id })
      await tx.query("UPDATE carts SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND status = 'checked_out'", { id: payment.cart_id })
    } else {
      await tx.query("UPDATE stock_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP WHERE payment_id = :id AND status = 'active'", { id: payment.id })
    }
    await createUserNotification(tx, payment, evidence.status)
    committedEvent = { payment_id: Number(payment.id), reference: payment.reference, status: evidence.status,
      request_id: currentRequestId() ?? 'unknown', event_id: evidence.eventId ?? null }
    committedUserId = Number(payment.user_id)
    logger.info({ payment_reference: payment.reference, payment_status: evidence.status, evidence_source: evidence.source, provider_event_id: evidence.eventId ?? null }, 'payment transition committed')
    return 'processed'
  })
  if (outcome === 'processed' && committedEvent && committedUserId !== undefined) eventHub?.publish(committedUserId, committedEvent)
  return outcome
}

export async function recordInvalidWebhook(db: Knex, bodyHash: string) {
  await immediate(db, async (tx) => createIncident(tx, {
    dedupeKey: `invalid_signature:${bodyHash}`, code: 'invalid_webhook_signature', details: 'A provider webhook failed HMAC authentication',
  }))
}
