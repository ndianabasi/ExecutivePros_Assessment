import knex, { type Knex } from 'knex'
import config from '../knexfile.js'

export function createDatabase(filename = process.env.API_DB_PATH ?? '/data/api.db'): Knex {
  return knex({ ...config, connection: { filename } })
}

export async function verifyDatabase(db: Knex): Promise<boolean> {
  try {
    const [migrations, foreignKeys, busyTimeout, journalMode] = await Promise.all([
      db.raw("SELECT name FROM knex_migrations WHERE name = '202611130001_initial_schema.ts'") as Promise<Array<{ name: string }>>,
      db.raw('PRAGMA foreign_keys') as Promise<Array<{ foreign_keys: number }>>,
      db.raw('PRAGMA busy_timeout') as Promise<Array<{ timeout: number }>>,
      db.raw('PRAGMA journal_mode') as Promise<Array<{ journal_mode: string }>>,
    ])
    return migrations.length === 1 && Number(foreignKeys[0]?.foreign_keys) === 1 &&
      Number(busyTimeout[0]?.timeout) > 0 &&
      String(journalMode[0]?.journal_mode).toLowerCase() === 'wal'
  } catch {
    return false
  }
}
