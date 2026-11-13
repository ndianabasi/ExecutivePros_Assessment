import './src/load-env.js'
import type { Knex } from 'knex'

const config: Knex.Config = {
  client: 'better-sqlite3',
  connection: { filename: process.env.API_DB_PATH ?? '/data/api.db' },
  useNullAsDefault: true,
  pool: {
    afterCreate(connection: { pragma: (statement: string) => unknown }, done: (error: Error | null, connection: unknown) => void) {
      try {
        connection.pragma('foreign_keys = ON')
        connection.pragma('busy_timeout = 5000')
        connection.pragma('journal_mode = WAL')
        done(null, connection)
      } catch (error) {
        done(error as Error, connection)
      }
    },
  },
  migrations: { directory: './database/migrations', extension: 'ts' },
  seeds: { directory: './database/seeds', extension: 'ts' },
}

export default config
