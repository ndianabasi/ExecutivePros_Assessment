import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeLocalSecrets } from '../../src/deployment/secret-files.mjs'
import { requiredSecrets } from '../../src/deployment/policy.mjs'
import { secretPath } from '../../src/deployment/platform.mjs'

test('first local deployment creates independent strong secrets and repeated setup preserves them', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-secrets-'))
  try {
    const hasPersistentData = async () => false
    const directory = await initializeLocalSecrets({ repositoryRoot, hasPersistentData })
    const firstValues = await Promise.all(
      requiredSecrets.map((name) => readFile(secretPath(repositoryRoot, name), 'utf8')),
    )
    assert.equal(new Set(firstValues).size, requiredSecrets.length)
    for (const name of requiredSecrets) {
      const info = await stat(secretPath(repositoryRoot, name))
      assert.equal((await readFile(secretPath(repositoryRoot, name), 'utf8')).trim().length >= 32, true)
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
    }
    if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700)

    await initializeLocalSecrets({ repositoryRoot, hasPersistentData })
    const secondValues = await Promise.all(
      requiredSecrets.map((name) => readFile(secretPath(repositoryRoot, name), 'utf8')),
    )
    assert.deepEqual(secondValues, firstValues)
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('isolated test secret files are generated idempotently outside development secrets', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-test-secrets-'))
  const directory = '.local/test-secrets'
  const options = { repositoryRoot, directory, hasPersistentData: async () => false }

  try {
    await initializeLocalSecrets(options)
    const firstValues = await Promise.all(
      requiredSecrets.map((name) =>
        readFile(secretPath(repositoryRoot, name, process.platform, directory), 'utf8'),
      ),
    )
    await initializeLocalSecrets(options)
    const secondValues = await Promise.all(
      requiredSecrets.map((name) =>
        readFile(secretPath(repositoryRoot, name, process.platform, directory), 'utf8'),
      ),
    )

    assert.equal(new Set(firstValues).size, requiredSecrets.length)
    assert.deepEqual(secondValues, firstValues)
    await assert.rejects(stat(secretPath(repositoryRoot, requiredSecrets[0])))
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('concurrent local deployments share exclusive secret creation without rotating keys', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-secrets-race-'))
  try {
    const options = { repositoryRoot, hasPersistentData: async () => false }
    await Promise.all(Array.from({ length: 4 }, () => initializeLocalSecrets(options)))
    const values = await Promise.all(
      requiredSecrets.map((name) => readFile(secretPath(repositoryRoot, name), 'utf8')),
    )
    assert.equal(new Set(values).size, requiredSecrets.length)
    assert.ok(values.every((value) => value.trim().length >= 32))
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('existing data with a missing secret fails closed and leaves other secret values unchanged', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-secrets-existing-'))
  try {
    await initializeLocalSecrets({ repositoryRoot, hasPersistentData: async () => false })
    const retainedName = requiredSecrets[1]
    const retainedValue = await readFile(secretPath(repositoryRoot, retainedName), 'utf8')
    await unlink(secretPath(repositoryRoot, requiredSecrets[0]))

    await assert.rejects(
      initializeLocalSecrets({ repositoryRoot, hasPersistentData: async () => true }),
      /Persistent data exists.*missing.*instead of rotating/,
    )
    assert.equal(await readFile(secretPath(repositoryRoot, retainedName), 'utf8'), retainedValue)
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})
