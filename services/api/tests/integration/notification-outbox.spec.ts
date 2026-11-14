import { test } from '@japa/runner'
import { useApiFixture } from '../macros.js'

test('notification outbox retries queue failures and records acceptance without changing its stable key', async ({ assert }) => {
  const { db, queue, dispatchOutbox } = await useApiFixture()
  assert.isDefined(queue)
  assert.isDefined(dispatchOutbox)
  const notificationKey = 'notify_payment_success_outbox_test'
  const payload = {
    type: 'email', notification_key: notificationKey, to: 'ada.user@example.test',
    subject: 'Payment successful', text: 'Your payment completed.', payment_reference: 'pay_outbox_test_1234567890',
  }
  const [id] = await db('notification_outbox').insert({
    queue_job_key: notificationKey, notification_type: 'payment_success', recipient: payload.to,
    payload: JSON.stringify(payload), next_attempt_at: new Date(Date.now() - 1000).toISOString(),
  })

  queue!.responseStatus = 503
  await dispatchOutbox!()
  let row = await db('notification_outbox').where({ id }).first()
  assert.equal(row.attempts, 1)
  assert.isNull(row.accepted_at)
  assert.isNull(row.lease_until)
  assert.equal(row.last_error, 'queue_http_503')
  assert.isTrue(Date.parse(row.next_attempt_at) > Date.now())
  assert.equal(queue!.requests[0]!.authorization, `Bearer ${'c'.repeat(32)}`)
  assert.equal(queue!.requests[0]!.body.notification_key, notificationKey)
  assert.match(queue!.requests[0]!.requestId, /^outbox:\d+:1$/)

  queue!.responseStatus = 202
  await db('notification_outbox').where({ id }).update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
  await dispatchOutbox!()
  row = await db('notification_outbox').where({ id }).first()
  assert.equal(row.attempts, 2)
  assert.isNotNull(row.accepted_at)
  assert.isNull(row.lease_until)
  assert.isNull(row.claim_token)
  assert.equal(queue!.requests.length, 2)
  assert.equal(queue!.requests[1]!.body.notification_key, notificationKey)
  assert.notEqual(queue!.requests[1]!.requestId, queue!.requests[0]!.requestId)
})
