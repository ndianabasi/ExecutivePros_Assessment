import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { ApiConfig } from './config.js'
import { logger } from './logging.js'
import { EmailQueueClient, type EmailJob, QueueRequestError } from './queue.js'
import { immediate } from './sqlite.js'

interface OutboxRow {
  id: number
  payload: string
  attempts: number
  claim_token: string
}

/**
 * Parses a persisted notification payload and rejects records outside the queue contract.
 *
 * @param payload - Validated event or notification data being persisted, transmitted, or displayed.
 *
 * @returns The validated or normalized value required by the caller.
 */
function parseJob(payload: string): EmailJob {
  const value: unknown = JSON.parse(payload)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'email' ||
    !('notification_key' in value) ||
    typeof value.notification_key !== 'string' ||
    !('to' in value) ||
    typeof value.to !== 'string' ||
    !('subject' in value) ||
    typeof value.subject !== 'string' ||
    !('text' in value) ||
    typeof value.text !== 'string'
  ) {
    throw new Error('Stored notification payload is invalid')
  }
  return value as EmailJob
}

/**
 * Calculates the bounded delay before the next provider or queue retry.
 *
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 * @param attempt - One-based retry attempt number used for history and backoff calculations.
 *
 * @returns A bounded delay in milliseconds before the next attempt.
 */
function retryDelay(config: ApiConfig, attempt: number): number {
  const base = Math.min(config.outboxRetryMaxMs, config.outboxRetryInitialMs * 2 ** Math.min(attempt - 1, 20))
  const jitter = config.nodeEnv === 'test' ? 1 : 0.75 + Math.random() * 0.5
  return Math.min(config.outboxRetryMaxMs, Math.floor(base * jitter))
}

/**
 * Creates the API outbox dispatcher that submits durable email intents to the queue.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param queue - Authenticated queue client used to submit a durable notification outbox job.
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 */
export function createNotificationOutboxDispatcher(db: Knex, queue: EmailQueueClient, config: ApiConfig) {
  let dispatchPromise: Promise<void> | undefined

  /**
   * Atomically claims due notification outbox rows so only one dispatcher owns each attempt.
   *
   * @returns The due notification outbox rows atomically claimed for delivery.
   */
  async function claimDue(): Promise<OutboxRow[]> {
    const now = new Date()
    const nowText = now.toISOString()
    const lease = new Date(now.getTime() + config.queueTimeoutMs + 5000).toISOString()
    return immediate(
      db,
      async (tx) => {
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
          if (updated[0]) {
            claimed.push({
              id: Number(updated[0].id),
              payload: row.payload,
              attempts: Number(updated[0].attempts),
              claim_token: token,
            })
          }
        }
        return claimed
      },
      config.sqliteLockAttempts,
    )
  }

  /**
   * Submits one claimed notification to the queue and records acceptance or the next retry time.
   *
   * @param row - Database row being mapped into a public or service-owned response shape.
   */
  async function deliver(row: OutboxRow) {
    const requestId = `outbox:${row.id}:${row.attempts}`
    try {
      const job = parseJob(row.payload)
      await queue.enqueue(job, requestId)
      await immediate(
        db,
        async (tx) => {
          await tx.query(
            `UPDATE notification_outbox SET accepted_at = :accepted, lease_until = NULL, claim_token = NULL, last_error = NULL
           WHERE id = :id AND claim_token = :token AND accepted_at IS NULL`,
            { accepted: new Date().toISOString(), id: row.id, token: row.claim_token },
          )
        },
        config.sqliteLockAttempts,
      )
      logger.info(
        { request_id: requestId, notification_outbox_id: row.id, attempt: row.attempts, outcome: 'accepted' },
        'notification intent accepted by queue',
      )
    } catch (error) {
      const failure =
        error instanceof QueueRequestError
          ? error.status
            ? `queue_http_${error.status}`
            : error.message
          : 'outbox_dispatch_failed'
      const next = new Date(Date.now() + retryDelay(config, row.attempts)).toISOString()
      await immediate(
        db,
        async (tx) => {
          await tx.query(
            `UPDATE notification_outbox SET next_attempt_at = :next, lease_until = NULL, claim_token = NULL, last_error = :failure
           WHERE id = :id AND claim_token = :token AND accepted_at IS NULL`,
            { next, failure: failure.slice(0, 100), id: row.id, token: row.claim_token },
          )
        },
        config.sqliteLockAttempts,
      )
      logger.warn(
        { request_id: requestId, notification_outbox_id: row.id, attempt: row.attempts, failure },
        'notification intent remains pending after queue failure',
      )
    }
  }

  /**
   * Claims and submits due notification outbox rows, then schedules bounded retries for uncertain delivery.
   */
  async function dispatchDue(): Promise<void> {
    if (dispatchPromise) {
      return dispatchPromise
    }
    dispatchPromise = (async () => {
      const rows = await claimDue()
      await Promise.all(
        rows.map((row) => {
          return deliver(row)
        }),
      )
    })()
    try {
      await dispatchPromise
    } finally {
      dispatchPromise = undefined
    }
  }

  return {
    dispatchDue,

    /**
     * Closes the owned stream, transport, database, or worker resources and releases their listeners.
     */
    async close() {
      await dispatchPromise
    },
  }
}
