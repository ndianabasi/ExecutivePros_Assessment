import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDefaultEnvironmentFile, setSecretFilePaths } from '../../src/deployment/env-file.mjs'

test('creates the default .env from the example only when it is missing', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-env-file-'))
  const template = 'FRONTEND_PORT=18080\nPROVIDER_WEBHOOK_SECRET_FILE=/run/secrets/provider_webhook_secret\n'

  try {
    await writeFile(join(repositoryRoot, '.env.example'), template)

    const envPath = await ensureDefaultEnvironmentFile({ repositoryRoot })

    assert.equal(envPath, join(repositoryRoot, '.env'))
    assert.equal(await readFile(envPath, 'utf8'), template)

    await writeFile(envPath, 'FRONTEND_PORT=19080\n')
    await ensureDefaultEnvironmentFile({ repositoryRoot })
    assert.equal(await readFile(envPath, 'utf8'), 'FRONTEND_PORT=19080\n')
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('does not create a missing custom env file from the default template', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-env-custom-'))

  try {
    await writeFile(join(repositoryRoot, '.env.example'), 'FRONTEND_PORT=18080\n')

    await assert.rejects(
      ensureDefaultEnvironmentFile({ repositoryRoot, envFile: '.local/demo.env' }),
      /only the default \.env is generated/,
    )
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('concurrent deploy startup creates a single default .env without failing', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-env-race-'))
  const template = 'FRONTEND_PORT=18080\n'

  try {
    await writeFile(join(repositoryRoot, '.env.example'), template)

    const paths = await Promise.all(
      Array.from({ length: 4 }, () => ensureDefaultEnvironmentFile({ repositoryRoot })),
    )

    assert.equal(new Set(paths).size, 1)
    assert.equal(await readFile(join(repositoryRoot, '.env'), 'utf8'), template)
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('writes stable relative secret paths while preserving other env values', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-env-secrets-'))
  const envPath = join(repositoryRoot, '.env')
  const initial = [
    'FRONTEND_PORT=19080',
    'PROVIDER_WEBHOOK_SECRET_FILE=/run/secrets/provider_webhook_secret',
    'PROVIDER_SERVICE_SECRET_FILE=/run/secrets/provider_service_secret',
    'QUEUE_SERVICE_SECRET_FILE=/run/secrets/queue_service_secret',
    '',
  ].join('\n')

  try {
    await writeFile(envPath, initial)

    await setSecretFilePaths({ repositoryRoot, envFile: '.env' })

    assert.equal(
      await readFile(envPath, 'utf8'),
      [
        'FRONTEND_PORT=19080',
        'PROVIDER_WEBHOOK_SECRET_FILE=./.local/secrets/provider_webhook_secret',
        'PROVIDER_SERVICE_SECRET_FILE=./.local/secrets/provider_service_secret',
        'QUEUE_SERVICE_SECRET_FILE=./.local/secrets/queue_service_secret',
        '',
      ].join('\n'),
    )
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})

test('rejects missing or duplicate secret file settings instead of writing an incomplete env file', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'assessment-env-invalid-'))
  const envPath = join(repositoryRoot, '.env')
  const initial = 'PROVIDER_WEBHOOK_SECRET_FILE=/run/secrets/provider_webhook_secret\n'

  try {
    await writeFile(envPath, initial)

    await assert.rejects(
      setSecretFilePaths({ repositoryRoot, envFile: '.env' }),
      /PROVIDER_SERVICE_SECRET_FILE must appear exactly once/,
    )
    assert.equal(await readFile(envPath, 'utf8'), initial)

    await writeFile(
      envPath,
      `${initial}PROVIDER_WEBHOOK_SECRET_FILE=duplicate\nPROVIDER_SERVICE_SECRET_FILE=value\nQUEUE_SERVICE_SECRET_FILE=value\n`,
    )
    await assert.rejects(
      setSecretFilePaths({ repositoryRoot, envFile: '.env' }),
      /PROVIDER_WEBHOOK_SECRET_FILE must appear exactly once/,
    )
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
})
