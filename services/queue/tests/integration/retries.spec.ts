import { test } from '@japa/runner'
import { useQueueFixture } from '../macros.js'

const job = {
  type: 'email',
  notification_key: 'retry-1',
  to: 'person@example.test',
  subject: 'Receipt',
  text: 'Paid',
}

async function waitFor(
  assert: { isTrue(value: boolean, message?: string): void },
  predicate: () => Promise<boolean>,
) {
  for (let count = 0; count < 100; count += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.isTrue(await predicate(), 'queue did not reach expected job state before timeout')
}

test('transient SMTP failures receive three total attempts and become dead', async ({ assert, client }) => {
  const fixture = useQueueFixture()
  fixture.behavior.failuresRemaining = 3
  const accepted = await client
    .post('/jobs')
    .header('Authorization', `Bearer ${fixture.config.serviceSecret}`)
    .json(job)
  assert.equal(accepted.status(), 202)
  await waitFor(assert, async () => (await fixture.runtime.worker.stats()).dead === 1)
  assert.equal(fixture.behavior.failuresRemaining, 0)
  assert.deepEqual(fixture.received, [])
})

test('permanent SMTP rejection is one attempt and Workmatic done does not mean delivered', async ({
  assert,
  client,
}) => {
  const fixture = useQueueFixture()
  fixture.behavior.permanentReject = true
  const accepted = await client
    .post('/jobs')
    .header('Authorization', `Bearer ${fixture.config.serviceSecret}`)
    .json(job)
  assert.equal(accepted.status(), 202)
  await waitFor(assert, async () => (await fixture.runtime.worker.stats()).done === 1)
  assert.isTrue(fixture.behavior.permanentReject)
  assert.deepEqual(fixture.received, [])
})
