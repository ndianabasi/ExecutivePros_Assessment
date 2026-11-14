import './load-env.js'
import { accessSync, constants } from 'node:fs'
import { createServer } from 'node:http'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { createQueueRuntime } from './jobs.js'
import { logger } from './logger.js'

const config = loadConfig()
const runtime = createQueueRuntime(config)
runtime.worker.start()
const app = createApp({
  config,
  client: runtime.client,
  worker: runtime.worker,
  readiness: {
    isDbWritable: () => {
      try {
        accessSync(config.jobsDbPath, constants.R_OK | constants.W_OK)
        return true
      } catch {
        return false
      }
    },
  },
})
const server = createServer(app)
server.listen(config.port, '0.0.0.0', () => {
  return logger.info({ port: config.port }, 'Queue service listening')
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
  logger.info({ signal }, 'Queue service shutdown started')
  const forceExit = setTimeout(() => {
    logger.error({ graceMs: config.shutdownGraceMs }, 'Queue shutdown grace period expired')
    process.exit(1)
  }, config.shutdownGraceMs)
  forceExit.unref()
  await new Promise<void>((resolve, reject) => {
    return server.close((error) => {
      return error ? reject(error) : resolve()
    })
  })
  await runtime.worker.stop()
  runtime.sender.close()
  await runtime.db.destroy()
  clearTimeout(forceExit)
  logger.info('Queue service shutdown complete')
}
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').catch((error) => {
    logger.error({ errorClass: error instanceof Error ? error.name : 'UnknownError' }, 'Shutdown failed')
    process.exitCode = 1
  })
})
process.once('SIGINT', () => {
  void shutdown('SIGINT').catch((error) => {
    logger.error({ errorClass: error instanceof Error ? error.name : 'UnknownError' }, 'Shutdown failed')
    process.exitCode = 1
  })
})
