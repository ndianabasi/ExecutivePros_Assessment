import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { localSecretsDirectory, secretPath } from './platform.mjs'
import { requiredSecrets, validateSecretContents } from './policy.mjs'

/**
 * Restricts a generated secret path to the current user on the active host platform.
 *
 * @param {string} path - Absolute secret file or directory path.
 * @param {boolean} directory - Whether to apply directory traversal permissions.
 * @param {object} options - Platform-specific permission implementation.
 * @param {string} [options.platform=process.platform] - Host platform whose permission model should be used.
 * @param {Function} [options.secureWindowsPath] - Test override for Windows ACL updates.
 * @returns {Promise<void>} Resolves when the path is owner-only.
 * @throws {Error} If the operating system cannot apply the required permission boundary.
 */
export async function makeOwnerOnly(
  path,
  directory,
  { platform = process.platform, secureWindowsPath } = {},
) {
  if (platform === 'win32') {
    const username = userInfo().username
    const permission = directory ? '(OI)(CI)F' : 'F'
    if (secureWindowsPath) return secureWindowsPath(path, username, permission)
    const result = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${username}:${permission}`], {
      encoding: 'utf8',
    })
    if (result.error || result.status !== 0)
      throw new Error(
        `Could not restrict Windows secret ACL for ${path}: ${result.stderr?.trim() || result.error?.message || result.status}`,
      )
    return
  }
  await chmod(path, directory ? 0o700 : 0o600)
}

/**
 * Creates one random secret with exclusive file creation, preserving a concurrent winner.
 *
 * @param {string} path - Absolute destination path for the generated secret.
 * @returns {Promise<void>} Resolves once this process or a concurrent process created a valid file.
 * @throws {Error} If file creation fails or a concurrent file remains incomplete.
 */
async function writeSecretOnce(path) {
  try {
    await writeFile(path, `${randomBytes(32).toString('base64url')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    // Concurrent local deploys share the winner's single exclusive create and never rotate it.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const contents = await readFile(path).catch(() => Buffer.alloc(0))
      if (contents.toString('utf8').trim().length >= 32) return
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    throw new Error(`Secret file ${path} exists but was not completely initialized`)
  }
}

/**
 * Creates or validates the independent service secrets in a selected local directory.
 *
 * @param {object} options - Secret provisioning and data-safety configuration.
 * @param {string} options.repositoryRoot - Absolute repository root for generated ignored files.
 * @param {Function} options.hasPersistentData - Reports whether the associated project already has persistent data.
 * @param {string} [options.platform=process.platform] - Host platform for path and permission handling.
 * @param {Function} [options.secureWindowsPath] - Test override for Windows ACL updates.
 * @param {string} [options.directory='.local/secrets'] - Repository-relative directory for this secret set.
 * @returns {Promise<string>} The absolute secret directory path.
 * @throws {Error} If an existing secret is unsafe, data exists without its original secret, or creation fails.
 */
export async function initializeLocalSecrets({
  repositoryRoot,
  hasPersistentData,
  platform = process.platform,
  secureWindowsPath,
  directory = '.local/secrets',
} = {}) {
  if (!repositoryRoot || typeof hasPersistentData !== 'function')
    throw new Error('Secret initialization requires a repository root and persistent-data check')
  const secretDirectory = localSecretsDirectory(repositoryRoot, platform, directory)
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(secretDirectory)
  if (!directoryInfo.isDirectory())
    throw new Error(`${directory} must be a real directory, not a symbolic link`)
  await makeOwnerOnly(secretDirectory, true, { platform, secureWindowsPath })

  const hasData = await hasPersistentData()
  for (const name of requiredSecrets) {
    const path = secretPath(repositoryRoot, name, platform, directory)
    try {
      await lstat(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (hasData)
        throw new Error(
          `Persistent data exists but ${directory}/${name} is missing; restore the original secret instead of rotating it.`,
        )
      await writeSecretOnce(path)
    }
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`${name} must be a regular file, not a symbolic link`)
    await makeOwnerOnly(path, false, { platform, secureWindowsPath })
    const securedInfo = await lstat(path)
    validateSecretContents(name, await readFile(path), securedInfo.mode, platform)
  }
  return secretDirectory
}
