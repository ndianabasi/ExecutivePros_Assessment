import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase, verifyDatabase } from './db.js'
import { ProviderClient } from './provider.js'

const config = loadConfig()
const db = createDatabase(config.dbPath)
const app = createApp({
  db,
  isReady: () => verifyDatabase(db),
  frontendOrigin: config.frontendOrigin,
  docsOrigin: config.docsOrigin,
  provider: new ProviderClient(config.providerBaseUrl, config.providerServiceSecret, config.providerTimeoutMs),
  config,
})

const server = app.listen(config.port, '0.0.0.0', () => {
  process.stdout.write(`API listening on port ${config.port}\n`)
})

process.on('SIGTERM', () => server.close(() => { void db.destroy() }))
process.on('SIGINT', () => server.close(() => { void db.destroy() }))
