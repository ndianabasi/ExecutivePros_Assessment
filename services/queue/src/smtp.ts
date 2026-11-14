import nodemailer, { type Transporter } from 'nodemailer'
import type { QueueConfig } from './config.js'
import type { EmailJob } from './jobs.js'

export interface SmtpSender {
  send(job: EmailJob): Promise<void>
  close(): void
}

/**
 * Creates an SMTP sender using the configured host, port, sender identity, and timeout.
 *
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 *
 * @returns The configured object, route set, or resource produced by this operation.
 */
export function createSmtpSender(
  config: Pick<QueueConfig, 'smtpHost' | 'smtpPort' | 'smtpFrom' | 'smtpTimeoutMs'>,
): SmtpSender {
  const transport: Transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: false,
    connectionTimeout: config.smtpTimeoutMs,
    greetingTimeout: config.smtpTimeoutMs,
    socketTimeout: config.smtpTimeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  return {
    /**
     * Submits the validated notification through the configured transport and reports delivery failures to the worker.
     *
     * @param job - Validated email notification job to submit or deliver.
     */
    async send(job) {
      await transport.sendMail({
        from: config.smtpFrom,
        to: job.to,
        subject: job.subject,
        text: job.text,
        ...(job.html === undefined ? {} : { html: job.html }),
      })
    },

    /**
     * Closes the owned stream, transport, database, or worker resources and releases their listeners.
     */
    close() {
      transport.close()
    },
  }
}
