export const regularServices = ['api', 'frontend', 'queue', 'docs', 'mailpit', 'provider']
export const requiredSecrets = ['queue_service_secret', 'provider_service_secret', 'provider_webhook_secret']
export const minimumComposeVersion = [5, 2, 0]

export function parseVersion(value) {
  const match = String(value).match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:\s|$)/)
  if (!match) throw new Error(`Cannot parse version: ${value}`)
  return match.slice(1, 4).map(Number)
}

export function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function validateProjectName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) {
    throw new Error('Compose project name must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens (48 characters maximum)')
  }
  return value
}

export function validateDisposableTarget(project, confirmation) {
  validateProjectName(project)
  if (!/^(test|e2e|disposable)-[a-z0-9][a-z0-9_-]{0,39}$/.test(project)) {
    throw new Error('Destructive database commands require a test-, e2e-, or disposable-prefixed project name')
  }
  if (confirmation !== project) throw new Error('Pass --confirm-project with the exact Compose project name')
  return project
}

export function validateSecretContents(name, contents, mode) {
  if (!Buffer.isBuffer(contents) || contents.toString('utf8').trim().length < 32) {
    throw new Error(`${name} must contain at least 32 non-whitespace bytes`)
  }
  if ((mode & 0o077) !== 0) throw new Error(`${name} must not be group- or world-readable`)
  return true
}

export function inspectComposeConfig(config) {
  if (!config || typeof config !== 'object' || !config.services || typeof config.services !== 'object') {
    throw new Error('Compose configuration did not contain a services map')
  }
  const serviceNames = Object.keys(config.services).sort()
  if (JSON.stringify(serviceNames) !== JSON.stringify([...regularServices].sort())) {
    throw new Error(`Compose must define exactly these six regular services: ${regularServices.join(', ')}`)
  }
  const expectedTargets = { api: 3000, frontend: 8080, queue: null, docs: 8080, mailpit: 8025, provider: 3000 }
  const hostPorts = new Set()
  for (const [name, service] of Object.entries(config.services)) {
    const ports = service.ports ?? []
    if (name === 'queue' && ports.length > 0) throw new Error('Queue HTTP must not be published on a host port')
    if (name === 'mailpit' && ports.some((port) => Number(port.target) === 1025)) throw new Error('Mailpit SMTP must remain internal to Compose')
    if (expectedTargets[name] !== null && (ports.length !== 1 || Number(ports[0]?.target) !== expectedTargets[name])) {
      throw new Error(`${name} must publish exactly its documented container port ${expectedTargets[name]}`)
    }
    for (const port of ports) {
      const published = Number(port.published)
      if (!Number.isInteger(published) || published < 10000) throw new Error(`${name} publishes a host port below 10000`)
      if (port.host_ip !== '127.0.0.1') throw new Error(`${name} must publish host ports only on 127.0.0.1`)
      if (hostPorts.has(published)) throw new Error(`Host port ${published} is published more than once`)
      hostPorts.add(published)
    }
  }
  return true
}

export function assertPinnedAlpineDockerfiles(entries) {
  for (const [file, content] of Object.entries(entries)) {
    const lines = content.split(/\r?\n/).filter((line) => /^\s*FROM\s+/i.test(line))
    if (lines.length === 0) throw new Error(`${file} does not declare a base image`)
    for (const line of lines) {
      const reference = line.trim().replace(/^FROM\s+/i, '').split(/\s+AS\s+/i)[0]
      if (!/(?:^|\/)alpine:/i.test(reference) && !/(?:^|\/)node:[^\s@]+-alpine/i.test(reference)) {
        throw new Error(`${file} must use an Alpine base image for every build and runtime stage`)
      }
      if (/\blatest\b/i.test(reference) || !/@sha256:[a-f0-9]{64}$/.test(reference)) {
        throw new Error(`${file} must pin every build and runtime base image to an exact digest`)
      }
      if (!/:\d+\.\d+\.\d+(?:[-._][A-Za-z0-9.]+)?@sha256:/.test(reference)) {
        throw new Error(`${file} must use a complete patch version for every base image`)
      }
    }
  }
  return true
}

export function validateBackupManifest(manifest) {
  if (!manifest || manifest.format !== 'executivepros-assessment-backup-v1' || !Array.isArray(manifest.archives)) {
    throw new Error('Unrecognized or incomplete backup manifest')
  }
  validateProjectName(manifest.project)
  if (!manifest.created_at || !manifest.source_volumes || !manifest.source_volume_ids || !manifest.image_ids || !manifest.secret_fingerprints) {
    throw new Error('Backup manifest is missing source, image, time, or secret-identity metadata')
  }
  for (const volume of ['assessment_data', 'mailpit_data']) {
    if (typeof manifest.source_volume_ids[volume] !== 'string' || manifest.source_volume_ids[volume].length === 0) throw new Error(`Backup manifest has no source volume ID for ${volume}`)
  }
  for (const secret of requiredSecrets) {
    if (!/^[a-f0-9]{64}$/.test(manifest.secret_fingerprints[secret] ?? '')) throw new Error(`Backup manifest has an invalid fingerprint for ${secret}`)
  }
  const names = new Set()
  for (const archive of manifest.archives) {
    if (!['assessment_data.tar.gz', 'mailpit_data.tar.gz'].includes(archive.name) || names.has(archive.name)) {
      throw new Error('Backup manifest contains an unexpected archive name')
    }
    if (!/^[a-f0-9]{64}$/.test(archive.sha256 ?? '')) throw new Error(`Backup manifest has an invalid checksum for ${archive.name}`)
    names.add(archive.name)
  }
  if (!names.has('assessment_data.tar.gz') || !names.has('mailpit_data.tar.gz')) throw new Error('Backup manifest must include both persistent volumes')
  return true
}
