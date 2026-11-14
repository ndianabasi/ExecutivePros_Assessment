import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const startup = resolve(process.cwd(), 'scripts/startup.mjs')
const defaults = {
  API_ORIGIN: 'http://127.0.0.1:18083',
  PROVIDER_ORIGIN: 'http://127.0.0.1:18082',
  DOCS_ORIGIN: 'http://127.0.0.1:18081',
  MAILPIT_ORIGIN: 'http://127.0.0.1:18025',
}

describe('container startup configuration', () => {
  it('writes only browser origins and creates matching CSP allowlists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontend-config-'))
    try {
      const result = spawnSync(process.execPath, [startup], { env: {
        ...process.env,
        ...defaults,
        FRONTEND_CONFIG_PATH: join(directory, 'config.json'),
        FRONTEND_NGINX_CONFIG_PATH: join(directory, 'nginx.conf'),
        FRONTEND_HEADERS_PATH: join(directory, 'headers.conf'),
        FRONTEND_TMP_PATH: directory,
      }, encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))).toEqual(defaults)
      const headers = await readFile(join(directory, 'headers.conf'), 'utf8')
      expect(headers).toContain(`connect-src 'self' ${defaults.API_ORIGIN}`)
      expect(headers).toContain(`frame-src ${defaults.PROVIDER_ORIGIN}`)
      expect(headers).not.toContain('token')
      const nginx = await readFile(join(directory, 'nginx.conf'), 'utf8')
      expect(nginx).toContain('try_files $uri $uri/ /index.html')
      expect(nginx).toContain('daemon off;')
      expect(nginx).toContain('max-age=31536000, immutable')
      expect(nginx).toContain(`${directory}/client_temp`)
      expect(nginx).toContain(`${directory}/fastcgi_temp`)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('refuses invalid and Compose-only API origins before writing config', async () => {
    for (const apiOrigin of ['api:3000', 'http://api:3000', 'http://127.0.0.1:18083/v1']) {
      const directory = await mkdtemp(join(tmpdir(), 'frontend-invalid-config-'))
      try {
        const result = spawnSync(process.execPath, [startup], { env: {
          ...process.env,
          ...defaults,
          API_ORIGIN: apiOrigin,
          FRONTEND_CONFIG_PATH: join(directory, 'config.json'),
          FRONTEND_NGINX_CONFIG_PATH: join(directory, 'nginx.conf'),
          FRONTEND_HEADERS_PATH: join(directory, 'headers.conf'),
          FRONTEND_TMP_PATH: directory,
        }, encoding: 'utf8' })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('API_ORIGIN')
      } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })
})
