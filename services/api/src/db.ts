import knex, { type Knex } from 'knex'
import config from '../knexfile.js'

export function createDatabase(filename = process.env.API_DB_PATH ?? '/data/api.db'): Knex {
  return knex({ ...config, connection: { filename } })
}
