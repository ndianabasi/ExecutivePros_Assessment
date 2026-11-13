import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase, verifyDatabase } from './db.js'

const config = loadConfig()
const db = createDatabase(config.dbPath)
const app = createApp({
  db,
  isReady: () => verifyDatabase(db),
  frontendOrigin: config.frontendOrigin,
  docsOrigin: config.docsOrigin,
})

const server = app.listen(config.port, '0.0.0.0', () => {
  process.stdout.write(`API listening on port ${config.port}\n`)
})

process.on('SIGTERM', () => server.close(() => { void db.destroy() }))
process.on('SIGINT', () => server.close(() => { void db.destroy() }))
