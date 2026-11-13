import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase } from './db.js'

const config = loadConfig()
const db = createDatabase(config.dbPath)
const app = createApp({
  db,
  isReady: async () => {
    try {
      const migrations = await db.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knex_migrations'") as unknown[]
      return migrations.length > 0
    } catch {
      return false
    }
  },
  frontendOrigin: config.frontendOrigin,
  docsOrigin: config.docsOrigin,
})

const server = app.listen(config.port, '0.0.0.0', () => {
  process.stdout.write(`API listening on port ${config.port}\n`)
})

process.on('SIGTERM', () => server.close(() => { void db.destroy() }))
process.on('SIGINT', () => server.close(() => { void db.destroy() }))
