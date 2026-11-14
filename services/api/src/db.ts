import knex, { type Knex } from 'knex'
import config from '../knexfile.js'

/**
 * Creates the service-owned Knex connection with SQLite foreign keys, WAL mode, and bounded lock waiting.
 *
 * @param filename - Service-owned SQLite database path used to open the connection.
 *
 * @returns The configured object, route set, or resource produced by this operation.
 */
export function createDatabase(filename = process.env.API_DB_PATH ?? '/data/api.db'): Knex {
  return knex({ ...config, connection: { filename } })
}

/**
 * Checks migrations, foreign keys, WAL mode, and SQLite timeout settings before serving requests.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 *
 * @returns Whether the supplied value satisfies the documented condition.
 */
export async function verifyDatabase(db: Knex): Promise<boolean> {
  try {
    const [migrations, foreignKeys, busyTimeout, journalMode] = await Promise.all([
      db.raw(
        "SELECT name FROM knex_migrations WHERE name IN ('202611130001_initial_schema.ts', '202611130001_initial_schema.js', '202611140002_notification_claim_token.ts', '202611140002_notification_claim_token.js', '202611140003_payment_reconciliation_claims.ts', '202611140003_payment_reconciliation_claims.js', '202611140004_reconciliation_attempt_history.ts', '202611140004_reconciliation_attempt_history.js')",
      ) as Promise<Array<{ name: string }>>,
      db.raw('PRAGMA foreign_keys') as Promise<Array<{ foreign_keys: number }>>,
      db.raw('PRAGMA busy_timeout') as Promise<Array<{ timeout: number }>>,
      db.raw('PRAGMA journal_mode') as Promise<Array<{ journal_mode: string }>>,
    ])
    const hasInitial = migrations.some((row) => {
      return row.name.startsWith('202611130001_initial_schema.')
    })
    const hasOutboxClaims = migrations.some((row) => {
      return row.name.startsWith('202611140002_notification_claim_token.')
    })
    const hasReconciliationClaims = migrations.some((row) => {
      return row.name.startsWith('202611140003_payment_reconciliation_claims.')
    })
    const hasReconciliationHistory = migrations.some((row) => {
      return row.name.startsWith('202611140004_reconciliation_attempt_history.')
    })
    return (
      hasInitial &&
      hasOutboxClaims &&
      hasReconciliationClaims &&
      hasReconciliationHistory &&
      Number(foreignKeys[0]?.foreign_keys) === 1 &&
      Number(busyTimeout[0]?.timeout) > 0 &&
      String(journalMode[0]?.journal_mode).toLowerCase() === 'wal'
    )
  } catch {
    return false
  }
}
