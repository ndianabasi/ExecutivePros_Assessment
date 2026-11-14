import './load-env.js'
import { loadConfig } from './config.js'
import { openQueue } from './jobs.js'
import { logger } from './logger.js'

const config = loadConfig()
const db = openQueue(config.jobsDbPath)
await db.destroy()
logger.info({ databaseInitialized: true }, 'Workmatic database initialized')
