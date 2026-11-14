import test from 'node:test'
import assert from 'node:assert/strict'
import { startAfterMigrations } from '../../src/deployment/manager.mjs'

test('runs all one-shot initialization before regular services start', () => {
  const calls = []
  startAfterMigrations('isolated-demo', '.env.test', (project, args, options) => calls.push({ project, args, options }))
  assert.deepEqual(calls.map(({ args }) => args.at(-1)), ['up', 'up', 'dist/src/initialize.js', 'dist/src/initialize-db.js', '--remove-orphans'])
  assert.deepEqual(calls.map(({ args }) => args[3]), ['api', 'provider', 'provider', 'queue', undefined])
  assert.ok(calls.every(({ project, options }) => project === 'isolated-demo' && options.envFile === '.env.test'))
})

test('a failed one-shot initializer stops the sequence before later initializers and Compose up', () => {
  const calls = []
  const runCompose = (project, args, options) => {
    calls.push({ project, args, options })
    if (args[3] === 'provider' && args.at(-1) === 'up') throw new Error('injected provider migration failure')
  }
  assert.throws(() => startAfterMigrations('isolated-demo', '.env.test', runCompose), /injected provider migration failure/)
  assert.equal(calls.length, 2)
  assert.equal(calls.some(({ args }) => args[0] === 'up'), false)
})
