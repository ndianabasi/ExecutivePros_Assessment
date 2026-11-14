import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const startup = new URL('../../scripts/startup.mjs', import.meta.url)

test('startup emits public origin-only config and origin-scoped CSP', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'api-docs-config-'))
  try {
    const result = spawnSync(process.execPath, [startup.pathname], {
      env: { ...process.env, API_ORIGIN: 'http://127.0.0.1:18083/', RUNTIME_DIR: runtime },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(await readFile(join(runtime, 'docs-config.json'), 'utf8')), {
      API_ORIGIN: 'http://127.0.0.1:18083',
    })
    const nginx = await readFile(join(runtime, 'nginx.conf'), 'utf8')
    assert.match(nginx, /connect-src 'self' http:\/\/127\.0\.0\.1:18083/)
    assert.match(nginx, /location = \/config\.json/)
    assert.match(nginx, /Cache-Control 'no-store'/)
  } finally {
    await rm(runtime, { recursive: true, force: true })
  }
})

test('startup rejects absent, malformed and Compose-only API origins', async () => {
  for (const origin of [undefined, 'api:3000', 'ftp://api.example.test', 'https://api.example.test/v1']) {
    const result = spawnSync(process.execPath, [startup.pathname], {
      env: { ...process.env, API_ORIGIN: origin, RUNTIME_DIR: tmpdir() },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, `expected invalid origin to fail: ${String(origin)}`)
  }
})
