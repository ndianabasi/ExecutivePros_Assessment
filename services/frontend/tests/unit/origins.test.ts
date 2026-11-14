import { describe, expect, it } from 'vitest'
import { parseBrowserOrigin, parseRuntimeConfig } from '../../src/origins'

const valid = {
  API_ORIGIN: 'http://127.0.0.1:18083',
  PROVIDER_ORIGIN: 'http://127.0.0.1:18082',
  DOCS_ORIGIN: 'http://127.0.0.1:18081',
  MAILPIT_ORIGIN: 'http://127.0.0.1:18025',
}

describe('browser origin configuration', () => {
  it('accepts the four host-browser origins and normalizes them', () => {
    expect(parseRuntimeConfig(valid)).toEqual(valid)
    expect(parseBrowserOrigin('https://shop.example.test:9443/', 'API_ORIGIN')).toBe('https://shop.example.test:9443')
  })

  it.each([
    ['api', 'API_ORIGIN'],
    ['http://api:3000', 'API_ORIGIN'],
    ['file:///tmp/config', 'API_ORIGIN'],
    ['http://user:password@127.0.0.1', 'API_ORIGIN'],
    ['http://127.0.0.1:18083/v1', 'API_ORIGIN'],
    ['http://127.0.0.1:18083?target=api', 'API_ORIGIN'],
  ])('rejects unsafe origin %s', (value, key) => {
    expect(() => parseBrowserOrigin(value, key)).toThrow()
  })

  it('requires every origin and rejects non-object configuration', () => {
    expect(() => parseRuntimeConfig({ ...valid, DOCS_ORIGIN: null })).toThrow('DOCS_ORIGIN')
    expect(() => parseRuntimeConfig(null)).toThrow('JSON object')
  })
})
