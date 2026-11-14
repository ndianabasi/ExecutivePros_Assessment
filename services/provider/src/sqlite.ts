import type { Knex } from 'knex'
import type { ProviderConfig } from './config.js'

export interface SqliteTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings?: Record<string, unknown>): Promise<T[]>
}

function isBusy(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && (error.code.includes('SQLITE_BUSY') || error.code.includes('SQLITE_LOCKED'))
}

export async function immediate<T>(db: Knex, config: ProviderConfig, work: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const connection = await db.client.acquireConnection()
    let began = false
    try {
      await db.raw('BEGIN IMMEDIATE').connection(connection)
      began = true
      const tx: SqliteTransaction = {
        async query<R extends Record<string, unknown>>(sql: string, bindings: Record<string, unknown> = {}) {
          return await db.raw(sql, bindings).connection(connection) as R[]
        },
      }
      const result = await work(tx)
      await db.raw('COMMIT').connection(connection)
      began = false
      return result
    } catch (error) {
      if (began) {
        try { await db.raw('ROLLBACK').connection(connection) } catch { /* Always release the pinned connection. */ }
      }
      if (!isBusy(error) || attempt >= config.sqliteLockAttempts) throw error
      await new Promise((resolve) => setTimeout(resolve, config.sqliteLockBackoffMs * attempt))
    } finally { await db.client.releaseConnection(connection) }
  }
}
