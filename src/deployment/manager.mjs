import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localSecretsDirectory, resolveRepositoryPath, secretPath } from './platform.mjs'
import { ensureDefaultEnvironmentFile, setSecretFilePaths } from './env-file.mjs'
import { initializeLocalSecrets, makeOwnerOnly } from './secret-files.mjs'
import {
  assertPinnedAlpineDockerfiles,
  compareVersions,
  inspectComposeConfig,
  minimumComposeVersion,
  parseVersion,
  regularServices,
  requiredSecrets,
  validateBackupManifest,
  validateDisposableTarget,
  validateProjectName,
  validateSecretContents,
} from './policy.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const alpineImage = 'alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf'
const defaultProject = 'executivepros_assessment'
const imageNames = {
  api: 'executivepros-api:0.1.0',
  frontend: 'executivepros-frontend:0.1.0',
  queue: 'executivepros-queue:0.1.0',
  docs: 'executivepros-api-docs:0.1.0',
  mailpit: 'executivepros-mailpit:v1.33.1',
  provider: 'executivepros-provider:0.1.0',
}
const serviceOwners = { api: 10001, queue: 10002, provider: 10003 }
const directStep = (_label, action) => action()

export async function runLoggedStep(label, action, logger = console) {
  logger.log(`starting: ${label}`)
  try {
    const result = await action()
    logger.log(`success: ${label}`)
    return result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error(`failed: ${label}: ${detail}`)
    throw error
  }
}

function run(command, args, { cwd = repoRoot, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    throw new Error(`${command} ${args[0] ?? ''} failed (${result.status}): ${detail}`)
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

function composeArgs(project, args, envFile = '.env') {
  validateProjectName(project)
  return ['compose', '--project-name', project, '--env-file', envFile, '--file', 'compose.yaml', ...args]
}

function compose(project, args, options = {}) {
  return run('docker', composeArgs(project, args, options.envFile), options)
}

function volumeName(project, volume) {
  return `${project}_${volume}`
}

function volumeExists(name) {
  return run('docker', ['volume', 'inspect', name], { allowFailure: true }).status === 0
}

function parseJsonLines(contents) {
  const trimmed = contents.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  }
}

function readEnvFile(value = '.env') {
  let path
  try { path = resolveRepositoryPath(repoRoot, value) } catch {
    throw new Error('Compose env file must exist inside this repository.')
  }
  if (!existsSync(path)) {
    throw new Error(
      'Compose env file must exist inside this repository; `yarn deploy:local` creates the default .env automatically.',
    )
  }
  return path
}

async function ensureSecrets(project) {
  return initializeLocalSecrets({
    repositoryRoot: repoRoot,
    hasPersistentData: async () => volumeExists(volumeName(project, 'assessment_data')) || volumeExists(volumeName(project, 'mailpit_data')),
  })
}

async function existingSecretFingerprints() {
  const secretDirectory = localSecretsDirectory(repoRoot)
  const directoryInfo = await lstat(secretDirectory).catch(() => null)
  if (!directoryInfo?.isDirectory()) throw new Error('Restore requires the original owner-only .local/secrets directory')
  await makeOwnerOnly(secretDirectory, true)
  const fingerprints = {}
  for (const name of requiredSecrets) {
    const path = secretPath(repoRoot, name)
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile()) throw new Error(`Restore requires the original regular file .local/secrets/${name}; it will not generate replacement secrets`)
    await makeOwnerOnly(path, false)
    const securedInfo = await lstat(path)
    const contents = await readFile(path)
    validateSecretContents(name, contents, securedInfo.mode, process.platform)
    fingerprints[name] = createHash('sha256').update(contents.toString('utf8').trim()).digest('hex')
  }
  return fingerprints
}

async function checkPortAvailable(port, project) {
  try {
    await new Promise((resolveListen, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => server.close(resolveListen))
    })
    return
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
  }
  const containers = parseJsonLines(run('docker', ['ps', '--format', '{{json .}}']).stdout)
  const matchesOwnedContainer = containers.some((container) => String(container.Names ?? '').startsWith(`${project}-`) && String(container.Ports ?? '').includes(`:${port}->`))
  if (!matchesOwnedContainer) throw new Error(`Host port ${port} is already in use by another process or Compose project`)
}

function validateDockerfiles() {
  const dockerfiles = [
    ['services/api/Dockerfile', 'services/api/Dockerfile'],
    ['services/frontend/Dockerfile', 'services/frontend/Dockerfile'],
    ['services/queue/Dockerfile', 'services/queue/Dockerfile'],
    ['services/api-docs/Dockerfile', 'services/api-docs/Dockerfile'],
    ['services/mock-email/Dockerfile', 'services/mock-email/Dockerfile'],
    ['services/provider/Dockerfile', 'services/provider/Dockerfile'],
  ]
  const entries = Object.fromEntries(dockerfiles.map(([key, path]) => [key, readFileSync(join(repoRoot, path), 'utf8')]))
  assertPinnedAlpineDockerfiles(entries)
}

function renderedConfig(project, envFile) {
  const output = compose(project, ['config', '--format', 'json'], { envFile }).stdout
  const config = JSON.parse(output)
  inspectComposeConfig(config)
  return config
}

async function checkHostPorts(project, config, step = directStep) {
  const ports = [...new Set(Object.values(config.services).flatMap((service) => (service.ports ?? []).map((port) => Number(port.published))))]
  for (const port of ports) await step(`Check host port ${port} availability`, () => checkPortAvailable(port, project))
}

export function validateOrigins(config) {
  const loopbackOrigin = (service) => `http://127.0.0.1:${config.services[service].ports?.[0]?.published}`
  const expected = [
    ['frontend', 'API_ORIGIN', 'api'],
    ['frontend', 'PROVIDER_ORIGIN', 'provider'],
    ['frontend', 'DOCS_ORIGIN', 'docs'],
    ['frontend', 'MAILPIT_ORIGIN', 'mailpit'],
    ['docs', 'API_ORIGIN', 'api'],
    ['api', 'API_PUBLIC_ORIGIN', 'api'],
    ['api', 'FRONTEND_ORIGIN', 'frontend'],
    ['api', 'DOCS_ORIGIN', 'docs'],
    ['api', 'PROVIDER_PUBLIC_ORIGIN', 'provider'],
    ['provider', 'PROVIDER_PUBLIC_ORIGIN', 'provider'],
    ['provider', 'FRONTEND_ORIGIN', 'frontend'],
  ]
  for (const [consumer, key, targetService] of expected) {
    const expectedOrigin = loopbackOrigin(targetService)
    if (config.services[consumer].environment[key] !== expectedOrigin) {
      throw new Error(`${consumer}.${key} must be derived from the published ${targetService} port (${expectedOrigin})`)
    }
  }
  return true
}

export async function preflight({ project = defaultProject, envFile: requestedEnvFile = '.env', checkPorts = true, step = directStep } = {}) {
  const envFile = await step('Validate project name and environment file', () => {
    validateProjectName(project)
    return readEnvFile(requestedEnvFile)
  })
  const composeVersion = await step('Check Docker Compose version', () => {
    const version = run('docker', ['compose', 'version', '--short']).stdout.trim()
    if (compareVersions(parseVersion(version), minimumComposeVersion) < 0) {
      throw new Error(`Docker Compose ${version} is too old; version 5.2.0 or newer is required for tested volume.subpath support`)
    }
    return version
  })
  await step('Check Docker daemon', () => run('docker', ['version', '--format', '{{.Server.Version}}']))
  await step('Check Node.js and Yarn versions', () => {
    const nodeVersion = process.versions.node.split('.').map(Number)
    if (compareVersions(nodeVersion, [24, 1, 0]) < 0) throw new Error('Node.js 24.1.0 or newer is required')
    const yarn = process.platform === 'win32'
      ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'yarn --version'])
      : run('yarn', ['--version'])
    const yarnVersion = parseVersion(yarn.stdout.trim())
    if (yarnVersion[0] < 4) throw new Error('Yarn 4 or newer is required')
  })
  await step('Check available workspace storage', () => {
    const freeBytes = statfsSync(repoRoot).bavail * statfsSync(repoRoot).bsize
    if (freeBytes < 1_073_741_824) throw new Error('At least 1 GiB of free workspace storage is required for image builds and cold backup')
  })
  await step('Validate pinned service images', () => validateDockerfiles())
  await step('Ensure local service secrets', () => ensureSecrets(project))
  await step('Set generated secret file paths in environment', () =>
    setSecretFilePaths({ repositoryRoot: repoRoot, envFile }),
  )
  const config = await step('Render Compose configuration', () => renderedConfig(project, envFile))
  await step('Validate port-derived browser origins', () => validateOrigins(config))
  if (checkPorts) await checkHostPorts(project, config, step)
  return { project, envFile, config, composeVersion }
}

async function createVolumes(project, step = directStep) {
  for (const name of ['assessment_data', 'mailpit_data']) {
    const volume = volumeName(project, name)
    await step(`Ensure persistent volume ${volume}`, () => {
      if (!volumeExists(volume)) run('docker', ['volume', 'create', '--label', `com.executivepros.assessment.project=${project}`, volume])
    })
  }
}

function prepareDataDirectories(project) {
  const volume = volumeName(project, 'assessment_data')
  const commands = Object.entries(serviceOwners).map(([service, uid]) => `mkdir -p /data/${service} && chown ${uid}:${uid} /data/${service} && chmod 0700 /data/${service}`).join(' && ')
  run('docker', ['run', '--rm', '--user', '0:0', '--mount', `type=volume,src=${volume},dst=/data`, alpineImage, 'sh', '-c', `chmod 0755 /data && ${commands}`])
}

function hasPersistentDatabaseFiles(project) {
  const volume = volumeName(project, 'assessment_data')
  if (!volumeExists(volume)) return false
  const result = run('docker', ['run', '--rm', '--mount', `type=volume,src=${volume},dst=/data,readonly`, alpineImage, 'sh', '-c', 'find /data -type f -print -quit'], { allowFailure: true })
  return result.status === 0 && result.stdout.trim().length > 0
}

function serviceNamesRunning(project, envFile = '.env') {
  const result = compose(project, ['ps', '--services', '--filter', 'status=running'], { allowFailure: true, envFile })
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((name) => regularServices.includes(name))
}

function imageIds() {
  return Object.fromEntries(Object.entries(imageNames).map(([service, image]) => {
    const result = run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { allowFailure: true })
    return [service, result.status === 0 ? result.stdout.trim() : 'not-built']
  }))
}

function stopAll(project, envFile = '.env') {
  compose(project, ['stop'], { envFile })
}

async function createColdBackup(project, outputDirectory, envFile = '.env', { alreadyStopped = false } = {}) {
  const sharedVolume = volumeName(project, 'assessment_data')
  const mailpitVolume = volumeName(project, 'mailpit_data')
  if (!volumeExists(sharedVolume) || !volumeExists(mailpitVolume)) throw new Error('Both persistent volumes must exist before backup')
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const absoluteOutput = resolve(outputDirectory)
  const label = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backupDirectory = join(absoluteOutput, `${project}-${label}`)
  await mkdir(backupDirectory, { mode: 0o700 })
  if (!alreadyStopped) stopAll(project, envFile)
  for (const [volume, archive] of [[sharedVolume, 'assessment_data.tar.gz'], [mailpitVolume, 'mailpit_data.tar.gz']]) {
    run('docker', ['run', '--rm', '--user', '0:0', '--mount', `type=volume,src=${volume},dst=/source,readonly`, '--mount', `type=bind,src=${backupDirectory},dst=/backup`, alpineImage, 'sh', '-c', `tar -czf /backup/${archive} -C /source .`])
    run('docker', ['run', '--rm', '--mount', `type=bind,src=${backupDirectory},dst=/backup,readonly`, alpineImage, 'tar', '-tzf', `/backup/${archive}`])
  }
  const archives = []
  for (const name of ['assessment_data.tar.gz', 'mailpit_data.tar.gz']) {
    const bytes = await readFile(join(backupDirectory, name))
    archives.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength })
  }
  const manifest = {
    format: 'executivepros-assessment-backup-v1',
    project,
    created_at: new Date().toISOString(),
    source_volumes: { assessment_data: sharedVolume, mailpit_data: mailpitVolume },
    source_volume_ids: { assessment_data: sharedVolume, mailpit_data: mailpitVolume },
    image_ids: imageIds(),
    secret_fingerprints: await existingSecretFingerprints(),
    archives,
  }
  validateBackupManifest(manifest)
  await writeFile(join(backupDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  return backupDirectory
}

export async function runMigrations(project, envFile = '.env', runCompose = compose, step = directStep) {
  const initializers = [
    ['Run API migrations and seed data', 'api', 'dist/bin/migrate.js', 'up'],
    ['Run provider migrations', 'provider', 'dist/bin/migrate.js', 'up'],
    ['Seed provider scenarios and initialize Workmatic', 'provider', 'dist/src/initialize.js'],
    ['Initialize queue database and Workmatic', 'queue', 'dist/src/initialize-db.js'],
  ]
  for (const [label, service, ...command] of initializers) {
    await step(label, () => runCompose(project, ['run', '--rm', '--no-deps', service, 'node', ...command], { envFile }))
  }
}

export async function startAfterMigrations(project, envFile = '.env', runCompose = compose, step = directStep) {
  await runMigrations(project, envFile, runCompose, step)
  await step('Start six regular services', () => runCompose(project, ['up', '--detach', '--remove-orphans'], { envFile }))
}

function parseComposeStatus(contents) {
  const rows = parseJsonLines(contents)
  return Object.fromEntries(rows.map((row) => [row.Service, { state: row.State, health: row.Health ?? '' }]))
}

async function waitForHealthy(project, envFile = '.env', timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = {}
  while (Date.now() < deadline) {
    const result = compose(project, ['ps', '--format', 'json'], { allowFailure: true, envFile })
    if (result.status === 0) lastStatus = parseComposeStatus(result.stdout)
    const exited = Object.entries(lastStatus).find(([, value]) => value.state === 'exited' || value.state === 'dead')
    if (exited) throw new Error(`${exited[0]} stopped before becoming healthy`)
    if (regularServices.every((service) => lastStatus[service]?.health === 'healthy')) return lastStatus
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
  }
  const summary = Object.entries(lastStatus).map(([name, state]) => `${name}:${state.health || state.state}`).join(', ')
  throw new Error(`Services did not become healthy in ${timeoutMs}ms (${summary || 'no containers reported'})`)
}

async function fetchChecked(url, name) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`)
  return response
}

export async function verifyDeploymentOrigins(config, step = directStep) {
  const loopbackOrigin = (service) => `http://127.0.0.1:${config.services[service].ports[0].published}`
  const origins = {
    frontend: loopbackOrigin('frontend'),
    provider: loopbackOrigin('provider'),
    docs: loopbackOrigin('docs'),
    mailpit: loopbackOrigin('mailpit'),
    api: loopbackOrigin('api'),
  }
  const endpoints = [
    [origins.frontend, 'frontend'],
    [`${origins.api}/health/ready`, 'API readiness'],
    [`${origins.provider}/health/ready`, 'provider readiness'],
    [`${origins.docs}/health/ready`, 'docs readiness'],
    [`${origins.mailpit}/readyz`, 'Mailpit readiness'],
  ]
  for (const [url, label] of endpoints) await step(`Verify ${label}`, () => fetchChecked(url, label))

  await step('Verify live OpenAPI server origin', async () => {
    const openApi = await (await fetchChecked(`${new URL(origins.api).origin}/v1/api_docs.json`, 'live API specification')).json()
    if (openApi.servers?.[0]?.url !== origins.api) throw new Error('Live OpenAPI server URL differs from the configured browser API origin')
  })

  const frontendOrigin = new URL(origins.frontend).origin
  const apiOrigin = new URL(origins.api).origin
  await step('Verify API CORS allows the frontend origin', async () => {
    const cors = await fetch(`${apiOrigin}/v1/products`, {
      method: 'OPTIONS',
      headers: { Origin: frontendOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' },
      signal: AbortSignal.timeout(5000),
    })
    if (cors.headers.get('access-control-allow-origin') !== frontendOrigin) throw new Error('API CORS does not allow the configured frontend origin')
  })

  await step('Verify provider framing policy', async () => {
    const providerResponse = await fetch(`${new URL(origins.provider).origin}/health/ready`, { cache: 'no-store' })
    const providerPolicy = providerResponse.headers.get('content-security-policy') ?? ''
    if (!providerPolicy.includes(`frame-ancestors ${frontendOrigin}`) || providerResponse.headers.has('x-frame-options')) {
      throw new Error('Provider framing policy does not permit the configured frontend')
    }
  })
  await step('Verify frontend runtime origins', async () => {
    const frontendResponse = await fetch(`${frontendOrigin}/config.json`, { cache: 'no-store' })
    const browserConfig = await frontendResponse.json()
    for (const [key, expected] of [['API_ORIGIN', origins.api], ['PROVIDER_ORIGIN', origins.provider], ['DOCS_ORIGIN', origins.docs], ['MAILPIT_ORIGIN', origins.mailpit]]) {
      if (browserConfig[key] !== expected) throw new Error(`Frontend runtime ${key} differs from its configured browser origin`)
    }
  })
  return true
}

export async function deployLocal({ project = defaultProject, envFile: requestedEnvFile = '.env', outputDirectory = '.local/backups' } = {}) {
  const step = (label, action) => runLoggedStep(label, action)
  await step('Prepare deployment environment file and create default .env if needed', () =>
    ensureDefaultEnvironmentFile({ repositoryRoot: repoRoot, envFile: requestedEnvFile }),
  )
  const { envFile, config } = await preflight({ project, envFile: requestedEnvFile, step })
  await step('Build all six service images', () => compose(project, ['build'], { envFile }))
  await createVolumes(project, step)
  await step('Prepare service-owned database directories', () => prepareDataDirectories(project))
  const hasData = await step('Check for existing persistent database files', () => hasPersistentDatabaseFiles(project))
  if (hasData) {
    await step('Stop services before the cold backup', () => stopAll(project, envFile))
    const backup = await step('Create and verify cold backup', () => createColdBackup(project, outputDirectory, envFile, { alreadyStopped: true }))
    console.log(`Verified cold backup: ${backup}`)
  }
  await startAfterMigrations(project, envFile, compose, step)
  await step('Wait for all six services to become healthy', () => waitForHealthy(project, envFile))
  await verifyDeploymentOrigins(config, step)
  console.log(`All six services are healthy for project ${project}; persistent volumes were preserved.`)
  console.log(`Frontend Service: http://127.0.0.1:${config.services.frontend.ports[0].published}`)
}

export async function migrateUp({ project = defaultProject, envFile: requestedEnvFile = '.env' } = {}) {
  const { envFile } = await preflight({ project, envFile: requestedEnvFile, checkPorts: false })
  compose(project, ['build', 'api', 'provider', 'queue'], { envFile })
  await createVolumes(project)
  prepareDataDirectories(project)
  await runMigrations(project, envFile)
  console.log(`API, provider, and queue database setup completed for ${project}; no regular service was started.`)
}

export async function databaseDown({ project, confirmProject, envFile: requestedEnvFile = '.env' }) {
  validateDisposableTarget(project, confirmProject)
  const envFile = readEnvFile(requestedEnvFile)
  compose(project, ['down', '--volumes', '--remove-orphans'], { envFile })
  console.log(`Removed containers and persistent volumes for explicitly disposable project ${project}.`)
}

export async function stopDeployment({ project = defaultProject, envFile: requestedEnvFile = '.env' } = {}) {
  validateProjectName(project)
  const envFile = readEnvFile(requestedEnvFile)
  compose(project, ['stop'], { envFile })
  console.log(`Stopped project ${project}; persistent volumes were preserved.`)
}

export async function showStatus({ project = defaultProject, envFile: requestedEnvFile = '.env' } = {}) {
  validateProjectName(project)
  const result = compose(project, ['ps', '--all'], { envFile: readEnvFile(requestedEnvFile) })
  process.stdout.write(result.stdout)
}

export async function backupDeployment({ project = defaultProject, envFile: requestedEnvFile = '.env', outputDirectory = '.local/backups' } = {}) {
  validateProjectName(project)
  const envFile = readEnvFile(requestedEnvFile)
  const running = serviceNamesRunning(project, envFile)
  if (!volumeExists(volumeName(project, 'assessment_data')) || !volumeExists(volumeName(project, 'mailpit_data'))) throw new Error(`Project ${project} does not have both persistent volumes`)
  stopAll(project, envFile)
  try {
    const path = await createColdBackup(project, outputDirectory, envFile, { alreadyStopped: true })
    console.log(`Cold backup verified: ${path}. Services remain stopped; run 'yarn deploy:local' to resume.`)
  } catch (error) {
    if (running.length > 0) compose(project, ['up', '--detach', '--no-build', ...running], { envFile, allowFailure: true })
    throw error
  }
}

async function restoreVolumeArchive(project, volume, directory, archive) {
  run('docker', ['volume', 'create', '--label', `com.executivepros.assessment.project=${project}`, volume])
  run('docker', ['run', '--rm', '--user', '0:0', '--mount', `type=volume,src=${volume},dst=/data`, '--mount', `type=bind,src=${directory},dst=/backup,readonly`, alpineImage, 'tar', '-xzf', `/backup/${archive}`, '-C', '/data', '--numeric-owner'])
}

function validateArchivePaths(directory, archive) {
  const listing = run('docker', ['run', '--rm', '--mount', `type=bind,src=${directory},dst=/backup,readonly`, alpineImage, 'tar', '-tzf', `/backup/${archive}`]).stdout
  for (const rawPath of listing.split(/\r?\n/).filter(Boolean)) {
    const normalized = rawPath.replace(/^\.\//, '')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`Backup archive ${archive} contains an unsafe path`)
  }
}

async function verifySqliteDatabase(project, service, database, expectedTable) {
  const command = `const db=require('better-sqlite3')('/data/${database}');const result=db.pragma('integrity_check');if(result.length!==1||result[0].integrity_check!=='ok')throw new Error('SQLite integrity check failed');if(!db.prepare(\"select 1 from sqlite_master where type='table' and name=?\").get('${expectedTable}'))throw new Error('Expected table missing');db.close()`
  compose(project, ['run', '--rm', '--no-deps', '--entrypoint', 'node', service, '-e', command])
}

export async function restoreDeployment({ backupDirectory, project, confirmProject, envFile: requestedEnvFile = '.env' } = {}) {
  validateDisposableTarget(project, confirmProject)
  const source = resolve(backupDirectory)
  if (!isAbsolute(source) || !existsSync(source)) throw new Error('Backup directory does not exist')
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  validateBackupManifest(manifest)
  if (manifest.project === project) throw new Error('Restore target must use a new project name separate from the backup source')
  for (const archive of manifest.archives) {
    const data = await readFile(join(source, archive.name))
    if (createHash('sha256').update(data).digest('hex') !== archive.sha256) throw new Error(`Backup checksum failed for ${archive.name}`)
    validateArchivePaths(source, archive.name)
  }
  const fingerprints = await existingSecretFingerprints()
  if (JSON.stringify(fingerprints) !== JSON.stringify(manifest.secret_fingerprints)) throw new Error('Backup secret fingerprints do not match this workspace; restore with the original ignored secret files')
  const envFile = readEnvFile(requestedEnvFile)
  for (const name of ['assessment_data', 'mailpit_data']) {
    const target = volumeName(project, name)
    if (volumeExists(target)) throw new Error(`Restore target volume already exists: ${target}`)
  }
  await restoreVolumeArchive(project, volumeName(project, 'assessment_data'), source, 'assessment_data.tar.gz')
  await restoreVolumeArchive(project, volumeName(project, 'mailpit_data'), source, 'mailpit_data.tar.gz')
  renderedConfig(project, envFile)
  for (const [service, database, table] of [['api', 'api.db', 'users'], ['provider', 'payment_provider.db', 'payments'], ['queue', 'jobs.db', 'workmatic_jobs']]) {
    await verifySqliteDatabase(project, service, database, table)
  }
  console.log(`Restored archives into new isolated project ${project}; SQLite integrity checks passed. No regular containers were started.`)
  console.log(`Validated project configuration from ${envFile}; verify required origins before switching traffic.`)
}
