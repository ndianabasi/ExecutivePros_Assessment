import { test } from '@japa/runner'
import { authenticate, listDemoUsers, login, logout } from '../../src/auth.js'
import { useApiFixture } from '../macros.js'

test('seeded user login stores only a token hash and logout revokes the session', async ({ assert }) => {
  const { db } = useApiFixture()
    const users = await listDemoUsers(db)
    assert.deepEqual(users.map(({ role }) => role), ['user', 'admin', 'user'])

    const result = await login(db, users[0]!.id, new Date('2026-11-13T00:00:00.000Z'))
    assert.isAbove(result.token.length, 32)
    const stored = await db.raw('SELECT token_hash, expires_at FROM user_tokens WHERE user_id = :userId', { userId: result.user.id }) as Array<{ token_hash: string; expires_at: string }>
    assert.notEqual(stored[0]?.token_hash, result.token)
    assert.equal(stored[0]?.expires_at, '2026-11-13T12:00:00.000Z')
    assert.deepEqual(await authenticate(db, result.token, new Date('2026-11-13T00:01:00.000Z')), {
      userId: result.user.id,
      role: 'user',
      tokenId: 1,
    })

    await logout(db, 1, new Date('2026-11-13T00:02:00.000Z'))
    assert.isNull(await authenticate(db, result.token, new Date('2026-11-13T00:03:00.000Z')))
})

test('inactive or unknown seeded user cannot log in', async ({ assert }) => {
  const { db } = useApiFixture()
    await db.raw('UPDATE users SET is_active = 0 WHERE id = 1')
    await assert.rejects(() => login(db, 1), /Unknown or inactive demo user/)
    await assert.rejects(() => login(db, 99), /Unknown or inactive demo user/)
})
