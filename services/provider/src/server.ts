import './load-env.js'
import { createServer } from 'node:http'
import { accessSync, constants } from 'node:fs'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { createDomainDatabase, openSharedDatabase, verifyProviderDatabase } from './db.js'
import { logger } from './logging.js'
import { createWebhookRuntime } from './webhooks.js'

const config = loadConfig()
const db = createDomainDatabase(config.dbPath)
const shared = openSharedDatabase(config.dbPath)
if (!(await verifyProviderDatabase(db, config, shared.native, shared.workmatic))) {
  await shared.workmatic.destroy()
  if (shared.native.open) {
    shared.native.close()
  }
  await db.destroy()
  throw new Error('Provider database schema or Workmatic database is not initialized')
}
const runtime = createWebhookRuntime(db, shared.workmatic, config)
runtime.worker.start()
await runtime.scheduleDueEvents()
const timer = setInterval(() => {
  void runtime.scheduleDueEvents().catch((error) => {
    return logger.error(
      { error_type: error instanceof Error ? error.name : 'unknown' },
      'provider webhook sweep failed',
    )
  })
}, config.sweepIntervalMs)

const app = createApp({
  db,
  config,
  isReady: async () => {
    try {
      accessSync(config.dbPath, constants.R_OK | constants.W_OK)
    } catch {
      return false
    }
    return verifyProviderDatabase(db, config, shared.native, shared.workmatic)
  },
  worker: runtime.worker,
  scheduleDueEvents: runtime.scheduleDueEvents,
})
const server = createServer(app)
server.listen(config.port, '0.0.0.0', () => {
  return logger.info({ port: config.port }, 'Provider service listening')
})

let stopping = false

/**
 * Stops accepting work, drains active operations within the grace period, and closes service resources.
 *
 * @param signal - Process shutdown signal that initiated the graceful stop sequence.
 */
async function shutdown(signal: string) {
  if (stopping) {
    return
  }
  stopping = true
  logger.info({ signal }, 'Provider shutdown started')
  const hardStop = setTimeout(() => {
    logger.error({ grace_ms: config.shutdownGraceMs }, 'Provider shutdown grace period expired')
    process.exit(1)
  }, config.shutdownGraceMs)
  hardStop.unref()
  clearInterval(timer)
  await new Promise<void>((resolve, reject) => {
    return server.close((error) => {
      return error ? reject(error) : resolve()
    })
  })
  await runtime.worker.stop()
  await shared.workmatic.destroy()
  if (shared.native.open) {
    shared.native.close()
  }
  await db.destroy()
  clearTimeout(hardStop)
  logger.info('Provider shutdown complete')
}
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').catch((error) => {
    logger.error({ error_type: error instanceof Error ? error.name : 'unknown' }, 'Provider shutdown failed')
    process.exitCode = 1
  })
})
process.once('SIGINT', () => {
  void shutdown('SIGINT').catch((error) => {
    logger.error({ error_type: error instanceof Error ? error.name : 'unknown' }, 'Provider shutdown failed')
    process.exitCode = 1
  })
})
