import type { Knex } from 'knex'

export interface SqliteTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings?: Record<string, unknown>): Promise<T[]>
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && (error.code.includes('SQLITE_BUSY') || error.code.includes('SQLITE_LOCKED'))
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run one safe write unit on a single Knex-owned connection with SQLite's write lock acquired up front. */
export async function immediate<T>(db: Knex, work: (tx: SqliteTransaction) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const connection = await db.client.acquireConnection()
    let began = false
    try {
      await db.raw('BEGIN IMMEDIATE').connection(connection)
      began = true
      const tx: SqliteTransaction = {
        async query<R extends Record<string, unknown>>(sql: string, bindings: Record<string, unknown> = {}) {
          const result = await db.raw(sql, bindings).connection(connection)
          return result as R[]
        },
      }
      const result = await work(tx)
      await db.raw('COMMIT').connection(connection)
      began = false
      return result
    } catch (error) {
      if (began) {
        try { await db.raw('ROLLBACK').connection(connection) } catch { /* connection is released below */ }
      }
      if (!isBusy(error) || attempt >= attempts) throw error
      await delay(100 * attempt)
    } finally {
      await db.client.releaseConnection(connection)
    }
  }
}
