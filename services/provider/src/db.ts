import Database from 'better-sqlite3'
import knex, { type Knex } from 'knex'
import { createDatabase as createWorkmaticDatabase, type WorkmaticDb } from 'workmatic'
import knexConfig from '../knexfile.js'
import type { ProviderConfig } from './config.js'

export function createDomainDatabase(filename: string): Knex {
  return knex({ ...knexConfig, connection: { filename } })
}

export function openSharedDatabase(filename: string): { native: Database.Database; workmatic: WorkmaticDb } {
  const native = new Database(filename)
  native.pragma('foreign_keys = ON')
  native.pragma('busy_timeout = 5000')
  native.pragma('journal_mode = WAL')
  const workmatic = createWorkmaticDatabase({ db: native })
  return { native, workmatic }
}

export async function verifyProviderDatabase(db: Knex, config: ProviderConfig, native: Database.Database, workmatic: WorkmaticDb): Promise<boolean> {
  try {
    const [migration, foreignKeys, busyTimeout, journalMode, scenarios] = await Promise.all([
      db.raw("SELECT name FROM knex_migrations WHERE name IN ('202611140001_provider_schema.ts', '202611140001_provider_schema.js')") as Promise<Array<{ name: string }>>,
      db.raw('PRAGMA foreign_keys') as Promise<Array<{ foreign_keys: number }>>,
      db.raw('PRAGMA busy_timeout') as Promise<Array<{ timeout: number }>>,
      db.raw('PRAGMA journal_mode') as Promise<Array<{ journal_mode: string }>>,
      db.raw('SELECT COUNT(*) AS count FROM failure_scenarios WHERE is_active = 1') as Promise<Array<{ count: number }>>,
    ])
    const workmaticTables = native.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('workmatic_jobs', 'workmatic_settings')").get() as { count: number }
    await workmatic.selectFrom('workmatic_settings').select('queue').limit(1).execute()
    return migration.length === 1 && Number(foreignKeys[0]?.foreign_keys) === 1 && Number(busyTimeout[0]?.timeout) > 0 &&
      String(journalMode[0]?.journal_mode).toLowerCase() === 'wal' && Number(scenarios[0]?.count) >= 10 && Number(workmaticTables.count) === 2 &&
      config.dbPath.length > 0
  } catch { return false }
}
