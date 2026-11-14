import './load-env.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase, verifyDatabase } from './db.js'
import { ProviderClient } from './provider.js'
import { createEmailQueueClient } from './queue.js'
import { createNotificationOutboxDispatcher } from './notification-outbox.js'
import { logger } from './logging.js'
import { PaymentEventHub } from './payment-events.js'

const config = loadConfig()
const db = createDatabase(config.dbPath)
const outbox = createNotificationOutboxDispatcher(db, createEmailQueueClient(config), config)
const eventHub = new PaymentEventHub()
const app = createApp({
  db,
  isReady: () => verifyDatabase(db),
  frontendOrigin: config.frontendOrigin,
  docsOrigin: config.docsOrigin,
  provider: new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs),
  config,
  eventHub,
})

const server = app.listen(config.port, '0.0.0.0', () => {
  process.stdout.write(`API listening on port ${config.port}\n`)
})

void outbox.dispatchDue().catch((error) => logger.error({ error_type: error instanceof Error ? error.name : 'unknown' }, 'notification outbox startup sweep failed'))
const outboxTimer = setInterval(() => {
  void outbox.dispatchDue().catch((error) => logger.error({ error_type: error instanceof Error ? error.name : 'unknown' }, 'notification outbox sweep failed'))
}, config.outboxIntervalMs)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'API shutdown started')
  clearInterval(outboxTimer)
  const hardStop = setTimeout(() => { logger.error({ grace_ms: 25000 }, 'API shutdown grace period expired'); process.exit(1) }, 25000)
  hardStop.unref()
  eventHub.close()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await outbox.close()
  await db.destroy()
  clearTimeout(hardStop)
  logger.info('API shutdown complete')
}
process.once('SIGTERM', () => { void shutdown('SIGTERM').catch((error) => { logger.error({ error_type: error instanceof Error ? error.name : 'unknown' }, 'API shutdown failed'); process.exitCode = 1 }) })
process.once('SIGINT', () => { void shutdown('SIGINT').catch((error) => { logger.error({ error_type: error instanceof Error ? error.name : 'unknown' }, 'API shutdown failed'); process.exitCode = 1 }) })
