import nodemailer, { type Transporter } from 'nodemailer'
import type { QueueConfig } from './config.js'
import type { EmailJob } from './jobs.js'

export interface SmtpSender {
  send(job: EmailJob): Promise<void>
  close(): void
}

export function createSmtpSender(config: Pick<QueueConfig, 'smtpHost' | 'smtpPort' | 'smtpFrom' | 'smtpTimeoutMs'>): SmtpSender {
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
    async send(job) {
      await transport.sendMail({
        from: config.smtpFrom,
        to: job.to,
        subject: job.subject,
        text: job.text,
        ...(job.html === undefined ? {} : { html: job.html }),
      })
    },
    close() { transport.close() },
  }
}
