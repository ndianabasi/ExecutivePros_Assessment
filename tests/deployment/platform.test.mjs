import test from 'node:test'
import assert from 'node:assert/strict'
import { localSecretsDirectory, pathApiFor, resolveRepositoryPath, secretPath } from '../../src/deployment/platform.mjs'
import { validateSecretContents } from '../../src/deployment/policy.mjs'

test('resolves the same ignored secret directory with native Windows, Linux, and macOS separators', () => {
  assert.equal(localSecretsDirectory('C:\\Users\\Demo\\Assessment', 'win32'), 'C:\\Users\\Demo\\Assessment\\.local\\secrets')
  assert.equal(secretPath('C:\\Users\\Demo\\Assessment', 'provider_service_secret', 'win32'), 'C:\\Users\\Demo\\Assessment\\.local\\secrets\\provider_service_secret')
  assert.equal(localSecretsDirectory('/home/demo/assessment', 'linux'), '/home/demo/assessment/.local/secrets')
  assert.equal(secretPath('/Users/demo/assessment', 'queue_service_secret', 'darwin'), '/Users/demo/assessment/.local/secrets/queue_service_secret')
  assert.equal(pathApiFor('win32').sep, '\\')
  assert.equal(pathApiFor('linux').sep, '/')
  assert.equal(pathApiFor('darwin').sep, '/')
})

test('keeps Compose env paths inside the repository on every supported host path style', () => {
  assert.equal(resolveRepositoryPath('C:\\Users\\Demo\\Assessment', '.local\\windows.env', 'win32'), 'C:\\Users\\Demo\\Assessment\\.local\\windows.env')
  assert.equal(resolveRepositoryPath('/home/demo/assessment', '.local/linux.env', 'linux'), '/home/demo/assessment/.local/linux.env')
  assert.equal(resolveRepositoryPath('/Users/demo/assessment', '.local/mac.env', 'darwin'), '/Users/demo/assessment/.local/mac.env')
  assert.throws(() => resolveRepositoryPath('C:\\Users\\Demo\\Assessment', '..\\outside.env', 'win32'), /inside the repository/)
  assert.throws(() => resolveRepositoryPath('/home/demo/assessment', '../outside.env', 'linux'), /inside the repository/)
})

test('accepts strong Windows secret contents without interpreting POSIX mode bits', () => {
  assert.equal(validateSecretContents('secret', Buffer.from('x'.repeat(32)), 0o100666, 'win32'), true)
  assert.throws(() => validateSecretContents('secret', Buffer.from('short'), 0o100666, 'win32'), /at least 32/)
})
