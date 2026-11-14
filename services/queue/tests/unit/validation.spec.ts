import { test } from '@japa/runner'
import { validateEmailJob } from '../../src/validation.js'

test('validates a narrow email job and carries its request id', async ({ assert }) => {
  const result = await validateEmailJob({ type: 'email', notification_key: 'notify-1', to: 'user@example.test', subject: 'Paid', text: 'Thanks' }, 'req-1')
  assert.isTrue(result.ok)
  if (result.ok) {
    assert.equal(result.value.request_id, 'req-1')
    assert.equal(result.value.to, 'user@example.test')
  }
})

test('rejects unknown fields, header injection, and unsupported job types', async ({ assert }) => {
  const invalidType = await validateEmailJob({ type: 'sms' }, 'req')
  const injectedHeader = await validateEmailJob({ type: 'email', notification_key: 'x', to: 'user@example.test', subject: 'a\r\nBcc:x', text: 'hi' }, 'req')
  const unknown = await validateEmailJob({ type: 'email', notification_key: 'x', to: 'user@example.test', subject: 'hi', text: 'body', headers: {} }, 'req')
  assert.isFalse(invalidType.ok)
  assert.isFalse(injectedHeader.ok)
  assert.isFalse(unknown.ok)
  if (!invalidType.ok) assert.equal(invalidType.status, 400)
  if (!injectedHeader.ok) assert.equal(injectedHeader.status, 422)
  if (!unknown.ok) assert.equal(unknown.status, 400)
})
