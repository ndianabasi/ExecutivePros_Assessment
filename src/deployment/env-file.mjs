import { constants } from 'node:fs'
import { copyFile, lstat, readFile, writeFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import { resolveRepositoryPath } from './platform.mjs'

const secretFilePaths = {
  PROVIDER_WEBHOOK_SECRET_FILE: './.local/secrets/provider_webhook_secret',
  PROVIDER_SERVICE_SECRET_FILE: './.local/secrets/provider_service_secret',
  QUEUE_SERVICE_SECRET_FILE: './.local/secrets/queue_service_secret',
}

/**
 * Creates the default repository `.env` from `.env.example` when it is absent.
 *
 * @param {object} options - Repository and environment-file configuration.
 * @param {string} options.repositoryRoot - Absolute path to the repository.
 * @param {string} [options.envFile='.env'] - Requested environment file path.
 * @param {string} [options.exampleFile='.env.example'] - Template path in the repository.
 * @param {boolean} [options.createCustomFromExample=false] - Whether a missing non-default env file may use its explicit template.
 * @param {boolean} [options.mergeMissingCustomDefaults=false] - Whether to append absent keys from a custom env template.
 * @returns {Promise<string>} The absolute path to the existing or created env file.
 * @throws {Error} If a custom missing env file is requested or paths escape the repository.
 */
export async function ensureDefaultEnvironmentFile({
  repositoryRoot,
  envFile = '.env',
  exampleFile = '.env.example',
  createCustomFromExample = false,
  mergeMissingCustomDefaults = false,
} = {}) {
  const targetPath = resolveRepositoryPath(repositoryRoot, envFile)
  const defaultPath = resolveRepositoryPath(repositoryRoot, '.env')

  const current = await lstat(targetPath).catch(() => null)
  if (current) {
    if (!current.isFile()) {
      throw new Error('The default .env must be a regular file, not a directory or symbolic link.')
    }
    if (targetPath !== defaultPath && mergeMissingCustomDefaults) {
      const templatePath = resolveRepositoryPath(repositoryRoot, exampleFile)
      const [contents, template] = await Promise.all([
        readFile(targetPath, 'utf8'),
        readFile(templatePath, 'utf8'),
      ])
      const currentValues = parse(contents)
      const missingKeys = new Set(Object.keys(parse(template)).filter((key) => !(key in currentValues)))
      if (missingKeys.size > 0) {
        const defaults = template.split(/\r?\n/).filter((line) => {
          const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
          return match && missingKeys.has(match[1])
        })
        const newline = contents.includes('\r\n') ? '\r\n' : '\n'
        const separator = contents.length > 0 && !contents.endsWith('\n') ? newline : ''
        await writeFile(targetPath, `${contents}${separator}${defaults.join(newline)}${newline}`, {
          encoding: 'utf8',
          mode: 0o600,
        })
      }
    }
    return targetPath
  }

  if (targetPath !== defaultPath && !createCustomFromExample) {
    throw new Error(
      'The requested Compose env file must already exist inside this repository; only the default .env is generated from .env.example.',
    )
  }

  const templatePath = resolveRepositoryPath(repositoryRoot, exampleFile)
  try {
    await copyFile(templatePath, targetPath, constants.COPYFILE_EXCL)
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error
    }
    const winner = await lstat(targetPath).catch(() => null)
    if (!winner?.isFile()) {
      throw error
    }
  }
  return targetPath
}

/**
 * Rewrites secret-file settings to the cross-platform relative paths used by Compose.
 *
 * @param {object} options - Repository and environment-file configuration.
 * @param {string} options.repositoryRoot - Absolute path to the repository.
 * @param {string} options.envFile - Existing environment file to update.
 * @param {string} [options.secretDirectory='.local/secrets'] - Repository-relative directory containing generated secret files.
 * @returns {Promise<string>} The absolute path to the updated env file.
 * @throws {Error} If any required secret-file setting is missing or duplicated.
 */
export async function setSecretFilePaths({
  repositoryRoot,
  envFile,
  secretDirectory = '.local/secrets',
} = {}) {
  const path = resolveRepositoryPath(repositoryRoot, envFile)
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile()) {
    throw new Error(`Compose env file ${envFile} must be a regular file, not a directory or symbolic link.`)
  }
  const contents = await readFile(path, 'utf8')
  const lines = contents.split(/\r?\n/)
  const normalizedDirectory = secretDirectory.replaceAll('\\', '/').replace(/^\.?\/+|\/+$/g, '')

  for (const [key, value] of Object.entries(secretFilePaths)) {
    const matchingLines = []
    for (let index = 0; index < lines.length; index += 1) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
        matchingLines.push(index)
      }
    }
    if (matchingLines.length !== 1) {
      throw new Error(`${key} must appear exactly once in ${envFile}`)
    }
    const fileName = value.slice(value.lastIndexOf('/') + 1)
    lines[matchingLines[0]] = `${key}=./${normalizedDirectory}/${fileName}`
  }

  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const updated = lines.join(newline)
  await writeFile(path, updated, { encoding: 'utf8', mode: 0o600 })
  return path
}
