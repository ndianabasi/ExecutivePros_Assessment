import { pino } from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'authorization', 'serviceSecret', 'to', 'recipient', 'text', 'html', 'body'],
    censor: '[REDACTED]',
  },
  base: { service: 'queue' },
})
