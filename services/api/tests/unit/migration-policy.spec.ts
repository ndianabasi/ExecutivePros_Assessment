import { test } from '@japa/runner'
import { assertDownMigrationAllowed } from '../../src/migration-policy.js'

test('down migrations are restricted to development and test environments', ({ assert }) => {
  assertDownMigrationAllowed('development')
  assertDownMigrationAllowed('test')
  assert.throws(() => assertDownMigrationAllowed('production'), 'API down migrations are allowed only in development or test')
})
