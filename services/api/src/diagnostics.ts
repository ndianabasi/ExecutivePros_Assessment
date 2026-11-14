import type { Express } from 'express'
import type { Knex } from 'knex'
import { requireAdmin, requireAuth } from './auth-middleware.js'

/** Operational counters contain no payment payloads, recipient details, or provider secrets. */
export function registerDiagnosticRoutes(app: Express, db: Knex) {
  app.get('/v1/admin/diagnostics', requireAuth(db), requireAdmin(), async (_request, response) => {
    const now = new Date().toISOString()
    const [payments, outbox, checkout, webhookOutcomes, incidents, reservations] = await Promise.all([
      db.raw(
        `SELECT COUNT(*) AS pending_count,
                SUM(CASE WHEN checkout_expires_at <= :now THEN 1 ELSE 0 END) AS expired_pending_count,
                MIN(created_at) AS oldest_pending_created_at
         FROM payments WHERE status = 'pending'`, { now },
      ) as Promise<Array<{ pending_count: number; expired_pending_count: number; oldest_pending_created_at: string | null }>>,
      db.raw(
        `SELECT COUNT(*) AS unaccepted_count,
                SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed_attempt_count,
                MIN(created_at) AS oldest_unaccepted_created_at
         FROM notification_outbox WHERE accepted_at IS NULL`,
      ) as Promise<Array<{ unaccepted_count: number; failed_attempt_count: number; oldest_unaccepted_created_at: string | null }>>,
      db.raw('SELECT COUNT(*) AS request_count FROM checkout_requests') as Promise<Array<{ request_count: number }>>,
      db.raw("SELECT outcome, COUNT(*) AS count FROM provider_events WHERE source = 'webhook' GROUP BY outcome ORDER BY outcome") as Promise<Array<{ outcome: string; count: number }>>,
      db.raw('SELECT code, COUNT(*) AS count FROM payment_incidents GROUP BY code ORDER BY code') as Promise<Array<{ code: string; count: number }>>,
      db.raw("SELECT COUNT(*) AS active_count, MIN(created_at) AS oldest_active_created_at FROM stock_reservations WHERE status = 'active'") as Promise<Array<{ active_count: number; oldest_active_created_at: string | null }>>,
    ])
    response.setHeader('Cache-Control', 'no-store')
    response.json({ data: {
      sampled_at: now,
      payments: {
        pending_count: Number(payments[0]?.pending_count ?? 0),
        expired_pending_count: Number(payments[0]?.expired_pending_count ?? 0),
        oldest_pending_created_at: payments[0]?.oldest_pending_created_at ?? null,
      },
      checkout: { idempotent_request_count: Number(checkout[0]?.request_count ?? 0) },
      webhook_outcomes: Object.fromEntries(webhookOutcomes.map((row) => [row.outcome, Number(row.count)])),
      incidents_by_code: Object.fromEntries(incidents.map((row) => [row.code, Number(row.count)])),
      stock_reservations: {
        active_count: Number(reservations[0]?.active_count ?? 0),
        oldest_active_created_at: reservations[0]?.oldest_active_created_at ?? null,
      },
      notification_outbox: {
        unaccepted_count: Number(outbox[0]?.unaccepted_count ?? 0),
        failed_attempt_count: Number(outbox[0]?.failed_attempt_count ?? 0),
        oldest_unaccepted_created_at: outbox[0]?.oldest_unaccepted_created_at ?? null,
      },
    } })
  })
}
