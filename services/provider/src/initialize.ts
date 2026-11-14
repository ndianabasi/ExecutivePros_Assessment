import './load-env.js'
import Database from 'better-sqlite3'
import { createDatabase as createWorkmaticDatabase } from 'workmatic'
import { loadConfig } from './config.js'

const config = loadConfig()
const native = new Database(config.dbPath)
native.pragma('foreign_keys = ON')
native.pragma('busy_timeout = 5000')
native.pragma('journal_mode = WAL')
const workmatic = createWorkmaticDatabase({ db: native })
try {
  const rows = native
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('workmatic_jobs', 'workmatic_settings')",
    )
    .get() as { count: number }
  if (Number(rows.count) !== 2) {
    throw new Error('Workmatic schema initialization failed')
  }
} finally {
  await workmatic.destroy()
  if (native.open) {
    native.close()
  }
}
