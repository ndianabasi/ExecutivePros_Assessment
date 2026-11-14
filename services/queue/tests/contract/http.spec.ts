import { test } from '@japa/runner'
import { useQueueFixture } from '../macros.js'

const validJob = {
  type: 'email',
  notification_key: 'c',
  to: 'person@example.test',
  subject: 'Paid',
  text: 'Thanks',
}

test('auth and validation errors follow the internal HTTP contract without enqueueing', async ({
  assert,
  client,
}) => {
  const fixture = useQueueFixture()
  const unauthorized = await client.post('/jobs').json(validJob)
  const unsupported = await client
    .post('/jobs')
    .header('Authorization', `Bearer ${fixture.config.serviceSecret}`)
    .json({ ...validJob, type: 'sms' })
  const invalidEmail = await client
    .post('/jobs')
    .header('Authorization', `Bearer ${fixture.config.serviceSecret}`)
    .json({ ...validJob, to: 'not-an-address' })
  const unknownField = await client
    .post('/jobs')
    .header('Authorization', `Bearer ${fixture.config.serviceSecret}`)
    .json({ ...validJob, headers: { bcc: 'leak@example.test' } })

  assert.equal(unauthorized.status(), 401)
  assert.equal(unsupported.status(), 400)
  assert.equal(invalidEmail.status(), 422)
  assert.equal(unknownField.status(), 400)
  assert.equal((await fixture.runtime.worker.stats()).total, 0)
})

test('malformed JSON and oversized request return their specified statuses', async ({ assert }) => {
  const fixture = useQueueFixture()
  const url = `http://127.0.0.1:${process.env.QUEUE_TEST_PORT}/jobs`
  const authorization = `Bearer ${fixture.config.serviceSecret}`
  const malformed = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: '{',
  })
  const oversized = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ ...validJob, text: 'x'.repeat(70000) }),
  })
  assert.equal(malformed.status, 400)
  assert.equal(oversized.status, 413)
  assert.equal((await fixture.runtime.worker.stats()).total, 0)
})

test('valid upstream request IDs are preserved and invalid values are replaced', async ({
  assert,
  client,
}) => {
  const accepted = await client.get('/health/live').header('x-request-id', 'api-request:abc-123')
  const replaced = await client.get('/health/live').header('x-request-id', 'invalid request id')
  assert.equal(accepted.header('x-request-id'), 'api-request:abc-123')
  assert.notEqual(replaced.header('x-request-id'), 'invalid request id')
  assert.isTrue((replaced.header('x-request-id') as string).length > 20)
})
