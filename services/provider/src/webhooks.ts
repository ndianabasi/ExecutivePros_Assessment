import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { createClient, createWorker, type WorkmaticDb } from 'workmatic'
import type { ProviderConfig } from './config.js'
import { logger } from './logging.js'
import { immediate } from './sqlite.js'

type EventRow = {
  id: number; event_id: string; payment_id: number; event_type: string; status: string;
  transmitted_body: string; transmitted_hash: string; signature_mode: string; delivery_rounds: number;
}
type DeliveryResult = { acknowledged: boolean; retryable: boolean; status?: number; errorClass?: string }

function hash(value: string | Buffer) { return createHash('sha256').update(value).digest('hex') }

async function boundedResponseText(response: Response, maxBytes = 2048): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (bytes < maxBytes) {
    const next = await reader.read()
    if (next.done) break
    const chunk = next.value.subarray(0, maxBytes - bytes)
    chunks.push(chunk)
    bytes += chunk.byteLength
    if (chunk.byteLength < next.value.byteLength) break
  }
  await reader.cancel().catch(() => undefined)
  return Buffer.concat(chunks).toString('utf8')
}

async function allocateAttempt(db: Knex, config: ProviderConfig, event: EventRow) {
  return immediate(db, config, async (tx) => {
    const rows = await tx.query<{ next: number }>('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM webhook_deliveries WHERE webhook_event_id = :id', { id: event.id })
    const attempt = Number(rows[0]?.next ?? 1)
    await tx.query(
      `INSERT INTO webhook_deliveries(webhook_event_id, attempt_number, request_body_hash, duration_ms)
       VALUES (:event_id, :attempt, :hash, 0)`, { event_id: event.id, attempt, hash: event.transmitted_hash },
    )
    return attempt
  })
}

async function recordAttempt(db: Knex, config: ProviderConfig, event: EventRow, attempt: number, result: DeliveryResult, responseText: string, durationMs: number) {
  await immediate(db, config, async (tx) => {
    await tx.query(
      `UPDATE webhook_deliveries SET http_status = :status, response_excerpt = :response, duration_ms = :duration,
         error_class = :error_class, completed_at = :completed
       WHERE webhook_event_id = :event_id AND attempt_number = :attempt`,
      { status: result.status ?? null, response: responseText.slice(0, 2048), duration: durationMs,
        error_class: result.errorClass ?? null, completed: new Date().toISOString(), event_id: event.id, attempt },
    )
  })
}

async function sendSubmission(db: Knex, config: ProviderConfig, event: EventRow): Promise<DeliveryResult> {
  const attempt = await allocateAttempt(db, config, event)
  const started = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs)
  let result: DeliveryResult
  let responseText = ''
  try {
    const bytes = Buffer.from(event.transmitted_body, 'utf8')
    const digest = createHmac('sha256', config.webhookSecret).update(bytes).digest('hex')
    const signature = event.signature_mode === 'invalid' ? `sha256=${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}` : `sha256=${digest}`
    const response = await fetch(config.apiWebhookUrl, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.byteLength),
        'x-provider-signature': signature, 'x-request-id': `provider-${event.event_id}` },
      body: bytes,
    })
    responseText = await boundedResponseText(response)
    const acknowledged = response.status >= 200 && response.status < 300
    const retryable = !acknowledged && (response.status >= 500 || response.status === 408 || response.status === 429 || response.status < 200)
    result = { acknowledged, retryable, status: response.status, ...(retryable ? { errorClass: 'RetryableHttpResponse' } : {}) }
  } catch (error) {
    result = { acknowledged: false, retryable: true, errorClass: error instanceof Error ? error.name : 'UnknownError' }
  } finally { clearTimeout(timeout) }
  const durationMs = Math.round(performance.now() - started)
  await recordAttempt(db, config, event, attempt, result, responseText, durationMs)
  logger.info({ provider_event_id: event.event_id, payment_id: event.payment_id, attempt_number: attempt,
    http_status: result.status ?? null, error_class: result.errorClass ?? null, duration_ms: durationMs,
    outcome: result.acknowledged ? 'acknowledged' : result.retryable ? 'retryable_failure' : 'permanent_rejection' }, 'provider webhook submission completed')
  return result
}

async function createConflictAfterAck(db: Knex, config: ProviderConfig, event: EventRow) {
  await immediate(db, config, async (tx) => {
    const payment = (await tx.query<{ reference: string; provider_reference: string; amount: number; currency: string; scenario_code: string | null }>(
      'SELECT reference, provider_reference, amount, currency, scenario_code FROM payments WHERE id = :id', { id: event.payment_id },
    ))[0]
    if (!payment || payment.scenario_code !== 'WEBHOOK_008') return
    const existing = (await tx.query<{ id: number }>("SELECT id FROM webhook_events WHERE payment_id = :id AND event_type = 'payment.failed'", { id: event.payment_id }))[0]
    if (existing) return
    const eventId = `evt_${randomUUID()}`
    const body = JSON.stringify({ event_id: eventId, event_type: 'payment.failed', status: 'failed', reference: payment.reference,
      provider_reference: payment.provider_reference, amount: payment.amount, currency: payment.currency, occurred_at: new Date().toISOString() })
    await tx.query(
      `INSERT INTO webhook_events(event_id, payment_id, event_type, status, canonical_body, transmitted_body, transmitted_hash,
         signature_mode, due_at, created_at)
       VALUES (:event_id, :payment_id, 'payment.failed', 'pending', :body, :body, :hash, 'valid', :due, :created)`,
      { event_id: eventId, payment_id: event.payment_id, body, hash: hash(body), due: new Date().toISOString(), created: new Date().toISOString() },
    )
  })
}

async function processDelivery(db: Knex, config: ProviderConfig, eventId: string) {
  const event = (await db.raw('SELECT * FROM webhook_events WHERE event_id = :id', { id: eventId }) as EventRow[])[0]
  if (!event || ['delivered', 'failed', 'skipped'].includes(event.status)) return
  const round = Number(event.delivery_rounds) + 1
  const scenario = (await db.raw('SELECT scenario_snapshot FROM payments WHERE id = :id', { id: event.payment_id }) as Array<{ scenario_snapshot: string | null }>)[0]?.scenario_snapshot
  const snapshot = scenario ? JSON.parse(scenario) as { code: string; config: Record<string, unknown> } : null
  const options = snapshot?.config ?? {}
  let copies = 1
  if (snapshot?.code === 'WEBHOOK_001') copies = Math.min(2, config.webhookCopies)
  if (snapshot?.code === 'WEBHOOK_002') copies = Math.min(3, config.webhookCopies)

  await immediate(db, config, async (tx) => {
    await tx.query("UPDATE webhook_events SET status = 'delivering', delivery_rounds = :round WHERE id = :id", { round, id: event.id })
  })
  let results: DeliveryResult[]
  if (options.concurrent === true && copies > 1) results = await Promise.all(Array.from({ length: copies }, () => sendSubmission(db, config, event)))
  else {
    results = []
    for (let index = 0; index < copies; index += 1) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, config.nodeEnv === 'test' ? config.copyIntervalMs : Number(options.interval_ms ?? 0)))
      results.push(await sendSubmission(db, config, event))
    }
  }
  const acknowledged = results.some((item) => item.acknowledged)
  const retryable = results.some((item) => item.retryable)
  const permanent = results.some((item) => !item.acknowledged && !item.retryable)
  if (acknowledged) {
    await immediate(db, config, async (tx) => {
      await tx.query("UPDATE webhook_events SET status = 'delivered', delivered_at = :now, claim_until = NULL, claim_id = NULL, last_error_class = NULL WHERE id = :id", { now: new Date().toISOString(), id: event.id })
    })
    if (snapshot?.code === 'WEBHOOK_008' && event.event_type === 'payment.success') await createConflictAfterAck(db, config, event)
    return
  }
  if (permanent) {
    await immediate(db, config, async (tx) => {
      await tx.query("UPDATE webhook_events SET status = 'failed', claim_until = NULL, claim_id = NULL, last_error_class = 'PermanentHttpResponse' WHERE id = :id", { id: event.id })
    })
    return
  }
  const finalRound = round >= config.maxAttempts
  await immediate(db, config, async (tx) => {
    await tx.query("UPDATE webhook_events SET status = :status, claim_until = NULL, claim_id = NULL, last_error_class = :error_class WHERE id = :id",
      { status: finalRound ? 'failed' : 'delivering', error_class: results.find((item) => item.retryable)?.errorClass ?? 'RetryableFailure', id: event.id })
  })
  if (retryable || finalRound) throw new Error(finalRound ? 'Webhook delivery rounds exhausted' : 'Webhook delivery received a retryable failure')
}

export function createWebhookRuntime(db: Knex, workmaticDb: WorkmaticDb, config: ProviderConfig) {
  const client = createClient({ db: workmaticDb, queue: 'webhooks' })
  const worker = createWorker({ db: workmaticDb, queue: 'webhooks', concurrency: config.workerConcurrency, leaseMs: config.leaseMs,
    pollMs: config.pollMs, timeoutMs: config.jobTimeoutMs,
    backoff: (attempt: number) => config.retryInitialMs * 2 ** Math.max(0, attempt - 1), persistState: false, autoRestore: false })
  worker.process(async (job: { id: string; attempts: number; payload: { event_id: string } }) => {
    await processDelivery(db, config, job.payload.event_id)
  })

  let sweeping = false
  async function scheduleDueEvents() {
    if (sweeping) return
    sweeping = true
    try {
      const now = new Date().toISOString()
      const claim = randomUUID()
      const due = await immediate(db, config, async (tx) => {
        await tx.query("UPDATE webhook_events SET status = 'pending', claim_id = NULL, claim_until = NULL WHERE status = 'pending' AND claim_until <= :now", { now })
        return tx.query<EventRow>(
          `SELECT * FROM webhook_events WHERE status = 'pending' AND job_id IS NULL AND due_at <= :now AND (claim_until IS NULL OR claim_until <= :now)
           ORDER BY due_at, id LIMIT 100`, { now },
        )
      })
      for (const event of due) {
        const acquired = await immediate(db, config, async (tx) => tx.query<{ id: number }>(
          `UPDATE webhook_events SET claim_id = :claim, claim_until = :until WHERE id = :id AND status = 'pending'
             AND (claim_until IS NULL OR claim_until <= :now) RETURNING id`,
          { claim, until: new Date(Date.now() + config.leaseMs).toISOString(), id: event.id, now },
        ))
        if (!acquired.length) continue
        try {
          const result = await client.add({ event_id: event.event_id }, { maxAttempts: config.maxAttempts })
          await immediate(db, config, async (tx) => {
            await tx.query('UPDATE webhook_events SET job_id = :job, claim_until = NULL, claim_id = NULL WHERE id = :id AND claim_id = :claim',
              { job: result.id, id: event.id, claim })
          })
        } catch (error) {
          await immediate(db, config, async (tx) => {
            await tx.query("UPDATE webhook_events SET claim_until = NULL, claim_id = NULL, due_at = :due WHERE id = :id AND claim_id = :claim",
              { due: new Date(Date.now() + 1000).toISOString(), id: event.id, claim })
          })
          logger.warn({ provider_event_id: event.event_id, error_class: error instanceof Error ? error.name : 'UnknownError' }, 'provider webhook job enqueue failed')
        }
      }
    } finally { sweeping = false }
  }
  return { client, worker, scheduleDueEvents }
}
