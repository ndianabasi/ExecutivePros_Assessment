import { describe, expect, it } from 'vitest'
import { isProviderUrl } from '../../src/components/PaymentDialog'

describe('provider URL guard', () => {
  it('accepts an HTTP(S) checkout URL only on the configured origin', () => {
    expect(isProviderUrl('http://127.0.0.1:18082/checkout/token', 'http://127.0.0.1:18082')).toBe(true)
    expect(
      isProviderUrl('https://provider.example.test/checkout/token', 'https://provider.example.test'),
    ).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'https://attacker.example/checkout',
    'https://user:secret@provider.example.test/checkout',
    'not a URL',
  ])('rejects %s', (url) => {
    expect(isProviderUrl(url, 'https://provider.example.test')).toBe(false)
  })
})
