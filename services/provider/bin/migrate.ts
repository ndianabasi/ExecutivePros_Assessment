import '../src/load-env.js'
import knex from 'knex'
import knexConfig from '../knexfile.js'
import { loadConfig } from '../src/config.js'

const action = process.argv[2]
if (action !== 'up' && action !== 'down') throw new Error('Use migrate:up or migrate:down')
const config = loadConfig()
if (action === 'down' && !['development', 'test'].includes(config.nodeEnv)) throw new Error('Provider down migrations are allowed only in development or test')

const db = knex(knexConfig)
try {
  if (action === 'up') {
    await db.migrate.latest()
    await db.seed.run()
  } else await db.migrate.rollback()
} finally { await db.destroy() }
