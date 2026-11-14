import { createClient, createDatabase, createWorker, type Job } from 'workmatic'
import type { QueueConfig } from './config.js'
import { createHash } from 'node:crypto'
import { logger } from './logger.js'
import { createSmtpSender, type SmtpSender } from './smtp.js'

export interface EmailJob {
  type: 'email'
  notification_key: string
  request_id: string
  to: string
  subject: string
  text: string
  html?: string
  payment_reference?: string
}

export function openQueue(path: string) {
  return createDatabase({ filename: path })
}

export function createQueueRuntime(config: QueueConfig, dependencies: { sender?: SmtpSender } = {}) {
  const db = openQueue(config.jobsDbPath)
  const client = createClient({ db, queue: 'emails' })
  const sender = dependencies.sender ?? createSmtpSender(config)
  const worker = createWorker({
    db,
    queue: 'emails',
    concurrency: config.workerConcurrency,
    leaseMs: config.leaseMs,
    pollMs: config.pollMs,
    timeoutMs: config.jobTimeoutMs,
    backoff: (attempt: number) => config.retryInitialMs * 2 ** Math.max(0, attempt - 1),
    persistState: false,
    autoRestore: false,
  })
  worker.process(async (job: Job<EmailJob>) => {
    const attempt = job.attempts + 1
    const notificationHash = createHash('sha256').update(job.payload.notification_key).digest('hex').slice(0, 16)
    const metadata = { requestId: job.payload.request_id, jobId: job.id, notificationHash, paymentReference: job.payload.payment_reference, attempt }
    const startedAt = performance.now()
    try {
      await sender.send(job.payload)
      logger.info({ ...metadata, outcome: 'smtp_accepted', durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, 'Email accepted by SMTP')
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'responseCode' in error ? Number(error.responseCode) : undefined
      const permanent = status !== undefined && status >= 500 && status < 600
      const reason = error instanceof Error ? error.name : 'UnknownError'
      if (permanent) {
        logger.error({ ...metadata, outcome: 'permanent_rejection', smtpResponseCode: status, errorClass: reason, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, 'SMTP permanently rejected email')
        return
      }
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100
      logger.warn({ ...metadata, outcome: 'transient_failure', smtpResponseCode: status, errorClass: reason, durationMs }, 'SMTP delivery attempt failed')
      if (attempt >= config.maxAttempts) logger.error({ ...metadata, outcome: 'transient_exhausted', smtpResponseCode: status, errorClass: reason, durationMs }, 'SMTP retries exhausted')
      throw error
    }
  })
  return { db, client, worker, sender }
}
