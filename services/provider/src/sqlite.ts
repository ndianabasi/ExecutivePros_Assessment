import type { Knex } from 'knex'
import type { ProviderConfig } from './config.js'

export interface SqliteTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings?: Record<string, unknown>,
  ): Promise<T[]>
}

/**
 * Checks whether an error represents a retryable SQLite busy or locked condition.
 *
 * @param error - Caught exception or dependency failure used to select safe error handling and retry behavior.
 */
function isBusy(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code.includes('SQLITE_BUSY') || error.code.includes('SQLITE_LOCKED'))
  )
}

/**
 * Runs a callback inside a bounded SQLite BEGIN IMMEDIATE transaction and commits or rolls it back atomically.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param config - Validated service configuration controlling the operation and dependency boundaries.
 * @param work - Database callback executed within a transaction or retry boundary.
 *
 * @returns The callback result after the transaction commits successfully.
 */
export async function immediate<T>(
  db: Knex,
  config: ProviderConfig,
  work: (tx: SqliteTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const connection = await db.client.acquireConnection()
    let began = false
    try {
      await db.raw('BEGIN IMMEDIATE').connection(connection)
      began = true
      const tx: SqliteTransaction = {
        /**
         * Performs the query operation for the provider service and returns its result to the caller.
         *
         * @param sql - Parameterized SQL statement executed by the service-owned database connection.
         * @param bindings - Named SQL values bound to the statement without string interpolation.
         */
        async query<R extends Record<string, unknown>>(sql: string, bindings: Record<string, unknown> = {}) {
          return (await db.raw(sql, bindings).connection(connection)) as R[]
        },
      }
      const result = await work(tx)
      await db.raw('COMMIT').connection(connection)
      began = false
      return result
    } catch (error) {
      if (began) {
        try {
          await db.raw('ROLLBACK').connection(connection)
        } catch {
          /* Always release the pinned connection. */
        }
      }
      if (!isBusy(error) || attempt >= config.sqliteLockAttempts) {
        throw error
      }
      await new Promise((resolve) => {
        return setTimeout(resolve, config.sqliteLockBackoffMs * attempt)
      })
    } finally {
      await db.client.releaseConnection(connection)
    }
  }
}
