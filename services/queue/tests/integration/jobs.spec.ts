import { test } from '@japa/runner'
import { useQueueFixture } from '../macros.js'

const queueTestPort = process.env.QUEUE_TEST_PORT

const validJob = {
  type: 'email', notification_key: 'notification-1', to: 'user@example.test',
  subject: 'Payment successful', text: 'Your payment succeeded.', payment_reference: 'pay-1',
}

test('durably accepts an authenticated job and delivers it through the worker', async ({ assert, client }) => {
  const fixture = useQueueFixture()
  const unauthorized = await client.post('/jobs').json(validJob)
  assert.equal(unauthorized.status(), 401)

  const accepted = await client.post('/jobs').header('Authorization', `Bearer ${fixture.config.serviceSecret}`).json(validJob)
  assert.equal(accepted.status(), 202)
  assert.equal(accepted.body().status, 'queued')
  assert.isString(accepted.body().job_id)
  assert.equal(accepted.body().request_id, accepted.header('x-request-id'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(fixture.received, ['user@example.test'])
})

test('repeated notification keys can create separate durable jobs', async ({ assert, client }) => {
  const fixture = useQueueFixture()
  const send = () => client.post('/jobs').header('Authorization', `Bearer ${fixture.config.serviceSecret}`).json(validJob)
  const first = await send()
  const second = await send()
  assert.equal(first.status(), 202)
  assert.equal(second.status(), 202)
  assert.notEqual(first.body().job_id, second.body().job_id)
})

test('health reports readiness and rejects non-JSON job submissions', async ({ assert, client }) => {
  const live = await client.get('/health/live')
  assert.equal(live.status(), 200)
  const ready = await client.get('/health/ready')
  assert.equal(ready.status(), 200)
  const unsupported = await fetch(`http://127.0.0.1:${queueTestPort}/jobs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${useQueueFixture().config.serviceSecret}`, 'content-type': 'text/plain' },
    body: 'not json',
  })
  const body = await unsupported.json() as { error: { request_id: string } }
  assert.equal(unsupported.status, 400)
  assert.equal(body.error.request_id, unsupported.headers.get('x-request-id'))
})
