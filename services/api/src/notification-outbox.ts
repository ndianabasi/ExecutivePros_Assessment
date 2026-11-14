import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { ApiConfig } from './config.js'
import { logger } from './logging.js'
import { EmailQueueClient, type EmailJob, QueueRequestError } from './queue.js'
import { immediate } from './sqlite.js'

interface OutboxRow { id: number; payload: string; attempts: number; claim_token: string }

function parseJob(payload: string): EmailJob {
  const value: unknown = JSON.parse(payload)
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'email' ||
      !('notification_key' in value) || typeof value.notification_key !== 'string' ||
      !('to' in value) || typeof value.to !== 'string' || !('subject' in value) || typeof value.subject !== 'string' ||
      !('text' in value) || typeof value.text !== 'string') throw new Error('Stored notification payload is invalid')
  return value as EmailJob
}

function retryDelay(config: ApiConfig, attempt: number): number {
  const base = Math.min(config.outboxRetryMaxMs, config.outboxRetryInitialMs * 2 ** Math.min(attempt - 1, 20))
  const jitter = config.nodeEnv === 'test' ? 1 : 0.75 + Math.random() * 0.5
  return Math.min(config.outboxRetryMaxMs, Math.floor(base * jitter))
}

export function createNotificationOutboxDispatcher(db: Knex, queue: EmailQueueClient, config: ApiConfig) {
  let dispatchPromise: Promise<void> | undefined

  async function claimDue(): Promise<OutboxRow[]> {
    const now = new Date()
    const nowText = now.toISOString()
    const lease = new Date(now.getTime() + config.queueTimeoutMs + 5000).toISOString()
    return immediate(db, async (tx) => {
      const due = await tx.query<{ id: number; payload: string }>(
        `SELECT id, payload FROM notification_outbox WHERE accepted_at IS NULL AND next_attempt_at <= :now
           AND (lease_until IS NULL OR lease_until <= :now) ORDER BY next_attempt_at, id LIMIT :limit`,
        { now: nowText, limit: config.jobBatchSize },
      )
      const claimed: OutboxRow[] = []
      for (const row of due) {
        const token = randomUUID()
        const updated = await tx.query<{ id: number; attempts: number }>(
          `UPDATE notification_outbox SET claim_token = :token, lease_until = :lease, attempts = attempts + 1
           WHERE id = :id AND accepted_at IS NULL AND next_attempt_at <= :now
             AND (lease_until IS NULL OR lease_until <= :now) RETURNING id, attempts`,
          { token, lease, id: row.id, now: nowText },
        )
        if (updated[0]) claimed.push({ id: Number(updated[0].id), payload: row.payload, attempts: Number(updated[0].attempts), claim_token: token })
      }
      return claimed
    }, config.sqliteLockAttempts)
  }

  async function deliver(row: OutboxRow) {
    const requestId = `outbox:${row.id}:${row.attempts}`
    try {
      const job = parseJob(row.payload)
      await queue.enqueue(job, requestId)
      await immediate(db, async (tx) => {
        await tx.query(
          `UPDATE notification_outbox SET accepted_at = :accepted, lease_until = NULL, claim_token = NULL, last_error = NULL
           WHERE id = :id AND claim_token = :token AND accepted_at IS NULL`,
          { accepted: new Date().toISOString(), id: row.id, token: row.claim_token },
        )
      }, config.sqliteLockAttempts)
      logger.info({ request_id: requestId, notification_outbox_id: row.id, attempt: row.attempts, outcome: 'accepted' }, 'notification intent accepted by queue')
    } catch (error) {
      const failure = error instanceof QueueRequestError ? error.status ? `queue_http_${error.status}` : error.message : 'outbox_dispatch_failed'
      const next = new Date(Date.now() + retryDelay(config, row.attempts)).toISOString()
      await immediate(db, async (tx) => {
        await tx.query(
          `UPDATE notification_outbox SET next_attempt_at = :next, lease_until = NULL, claim_token = NULL, last_error = :failure
           WHERE id = :id AND claim_token = :token AND accepted_at IS NULL`,
          { next, failure: failure.slice(0, 100), id: row.id, token: row.claim_token },
        )
      }, config.sqliteLockAttempts)
      logger.warn({ request_id: requestId, notification_outbox_id: row.id, attempt: row.attempts, failure }, 'notification intent remains pending after queue failure')
    }
  }

  async function dispatchDue(): Promise<void> {
    if (dispatchPromise) return dispatchPromise
    dispatchPromise = (async () => {
      const rows = await claimDue()
      await Promise.all(rows.map((row) => deliver(row)))
    })()
    try { await dispatchPromise } finally { dispatchPromise = undefined }
  }

  return {
    dispatchDue,
    async close() { await dispatchPromise },
  }
}
