import { createHash, randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { HttpError } from './errors.js'

export interface AuthUser {
  id: number
  first_name: string
  last_name: string
  email: string
  role: 'user' | 'admin'
  is_active: number
}

export interface AuthContext {
  userId: number
  role: 'user' | 'admin'
  tokenId: number
}

interface TokenRow {
  token_id: number
  user_id: number
  role: 'user' | 'admin'
}

/**
 * Normalizes Knex raw-query results into a consistent row array for typed database access.
 *
 * @param result - Raw query or operation result to normalize before it is returned to a caller.
 *
 * @returns The raw-query rows cast to the caller-specified row type.
 */
function rows<T>(result: unknown): T[] {
  return result as T[]
}

/**
 * Selects active seeded users and returns only the profile fields that the trusted demo login needs.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 *
 * @returns The requested value or matching records from the configured service source.
 */
export async function listDemoUsers(
  db: Knex,
): Promise<Array<Pick<AuthUser, 'id' | 'first_name' | 'last_name' | 'role'>>> {
  const result = await db.raw(
    'SELECT id, first_name, last_name, role FROM users WHERE is_active = 1 ORDER BY id ASC',
  )
  return rows<Pick<AuthUser, 'id' | 'first_name' | 'last_name' | 'role'>>(result)
}

/**
 * Issues a random bearer session for an active seeded user and persists only the SHA-256 token hash.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param userId - Seeded-user identifier used to scope authentication, payments, or stored preferences.
 * @param now - Current time supplied explicitly to make expiry and retry behavior deterministic in tests.
 *
 * @returns The one-time bearer token and public profile for the selected active seeded user.
 */
export async function login(
  db: Knex,
  userId: number,
  now = new Date(),
): Promise<{ token: string; user: AuthUser }> {
  const found = rows<AuthUser>(
    await db.raw(
      'SELECT id, first_name, last_name, email, role, is_active FROM users WHERE id = :userId AND is_active = 1',
      { userId },
    ),
  )[0]
  if (!found) {
    throw new HttpError(401, 'invalid_user', 'Unknown or inactive demo user')
  }

  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString()
  await db.raw(
    'INSERT INTO user_tokens (user_id, token_hash, expires_at) VALUES (:userId, :tokenHash, :expiresAt)',
    { userId, tokenHash, expiresAt },
  )
  return { token, user: found }
}

/**
 * Hashes the bearer token, checks revocation, expiry, and user activity, then returns the authenticated role context.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param token - Bearer or checkout token used to authenticate or correlate the operation.
 * @param now - Current time supplied explicitly to make expiry and retry behavior deterministic in tests.
 *
 * @returns The authenticated user ID, role, and session ID, or null when the token is invalid or expired.
 */
export async function authenticate(db: Knex, token: string, now = new Date()): Promise<AuthContext | null> {
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const found = rows<TokenRow>(
    await db.raw(
      `SELECT t.id AS token_id, u.id AS user_id, u.role
     FROM user_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = :tokenHash AND t.revoked_at IS NULL
       AND t.expires_at > :now AND u.is_active = 1`,
      { tokenHash, now: now.toISOString() },
    ),
  )[0]
  if (!found) {
    return null
  }
  return { userId: found.user_id, role: found.role, tokenId: found.token_id }
}

/**
 * Best-effort revokes the current API token, aborts requests, and clears local identity state.
 *
 * @param db - Service-owned database connection used for the required persistent read or write.
 * @param tokenId - Database ID of the bearer session that is being revoked.
 * @param now - Current time supplied explicitly to make expiry and retry behavior deterministic in tests.
 */
export async function logout(db: Knex, tokenId: number, now = new Date()): Promise<void> {
  await db.raw('UPDATE user_tokens SET revoked_at = COALESCE(revoked_at, :now) WHERE id = :tokenId', {
    tokenId,
    now: now.toISOString(),
  })
}
