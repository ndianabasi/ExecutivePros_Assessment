import '../src/load-env.js'
import knex from 'knex'
import knexConfig from '../knexfile.js'
import { loadConfig } from '../src/config.js'
import { assertDownMigrationAllowed } from '../src/migration-policy.js'

const action = process.argv[2]
if (action !== 'up' && action !== 'down') {
  throw new Error('Use migrate:up or migrate:down')
}
const config = loadConfig()
if (action === 'down') {
  assertDownMigrationAllowed(config.nodeEnv)
}

const db = knex(knexConfig)
try {
  if (action === 'up') {
    await db.migrate.latest()
    await db.seed.run()
  } else {
    await db.migrate.rollback()
  }
} finally {
  await db.destroy()
}
