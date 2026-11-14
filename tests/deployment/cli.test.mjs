import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

function cli(args) {
  return spawnSync(process.execPath, ['bin/assessment.mjs', ...args], { cwd: root, encoding: 'utf8' })
}

test('exposes all documented deployment operations', () => {
  const result = cli(['--help'])
  assert.equal(result.status, 0, result.stderr)
  for (const command of ['deploy:local', 'db:up', 'db:down', 'backup', 'restore', 'status', 'stop']) {
    assert.match(result.stdout, new RegExp(`\\b${command.replace(':', ':')}\\b`))
  }
})

test('requires explicit exact confirmation and rejects the normal project for db:down', () => {
  const missing = cli(['db:down'])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /required option/)

  const unsafe = cli(['db:down', '--project', 'executivepros_assessment', '--confirm-project', 'executivepros_assessment'])
  assert.notEqual(unsafe.status, 0)
  assert.match(unsafe.stderr, /disposable/)
})

test('restore requires an isolated project and exact confirmation before touching Docker', () => {
  const missing = cli(['restore', '.local/backups/missing'])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /required option/)

  const mismatch = cli(['restore', '.local/backups/missing', '--project', 'e2e-restore', '--confirm-project', 'e2e-other'])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /exact Compose project/)
})
