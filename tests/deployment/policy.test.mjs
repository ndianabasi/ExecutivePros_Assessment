import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertPinnedAlpineDockerfiles,
  compareVersions,
  inspectComposeConfig,
  parseVersion,
  regularServices,
  requiredSecrets,
  validateBackupManifest,
  validateDisposableTarget,
  validateProjectName,
  validateSecretContents,
} from '../../src/deployment/policy.mjs'

test('parses and compares complete tool versions', () => {
  assert.deepEqual(parseVersion('Docker Compose version v5.2.0'), [5, 2, 0])
  assert.deepEqual(parseVersion('24.1.0'), [24, 1, 0])
  assert.equal(compareVersions([5, 2, 0], [5, 2, 0]), 0)
  assert.equal(compareVersions([5, 1, 99], [5, 2, 0]), -1)
  assert.equal(compareVersions([5, 2, 1], [5, 2, 0]), 1)
  assert.throws(() => parseVersion('unknown'), /Cannot parse version/)
})

test('accepts safe project names and requires exact disposable confirmation', () => {
  assert.equal(validateProjectName('executivepros_assessment'), 'executivepros_assessment')
  assert.equal(validateDisposableTarget('e2e-checkout_1', 'e2e-checkout_1'), 'e2e-checkout_1')
  for (const name of ['Uppercase', '-bad', 'bad.name', 'a'.repeat(49)]) assert.throws(() => validateProjectName(name))
  assert.throws(() => validateDisposableTarget('executivepros_assessment', 'executivepros_assessment'), /disposable/)
  assert.throws(() => validateDisposableTarget('test-reset', 'test-reset-other'), /exact Compose project/)
})

test('requires strong owner-only secret contents', () => {
  assert.equal(validateSecretContents('secret', Buffer.from('x'.repeat(32)), 0o100600), true)
  assert.throws(() => validateSecretContents('secret', Buffer.from('short'), 0o100600), /at least 32/)
  assert.throws(() => validateSecretContents('secret', Buffer.from('x'.repeat(32)), 0o100644), /group- or world-readable/)
})

function composeConfig(overrides = {}) {
  const basePorts = {
    frontend: [{ host_ip: '127.0.0.1', published: '18080', target: 8080 }],
    docs: [{ host_ip: '127.0.0.1', published: '18081', target: 8080 }],
    provider: [{ host_ip: '127.0.0.1', published: '18082', target: 3000 }],
    api: [{ host_ip: '127.0.0.1', published: '18083', target: 3000 }],
    mailpit: [{ host_ip: '127.0.0.1', published: '18025', target: 8025 }],
    queue: [],
  }
  return { services: Object.fromEntries(regularServices.map((name) => [name, { ports: basePorts[name], ...overrides[name] }])) }
}

test('validates exactly six services with loopback high ports and private service ports', () => {
  const config = composeConfig({
    frontend: { ports: [{ host_ip: '127.0.0.1', published: '18080', target: 8080 }] },
    mailpit: { ports: [{ host_ip: '127.0.0.1', published: '18025', target: 8025 }] },
  })
  assert.equal(inspectComposeConfig(config), true)
  assert.throws(() => inspectComposeConfig({ services: { ...config.services, extra: {} } }), /exactly these six/)
  assert.throws(() => inspectComposeConfig(composeConfig({ api: { ports: [{ host_ip: '0.0.0.0', published: '18083', target: 3000 }] } })), /127.0.0.1/)
  assert.throws(() => inspectComposeConfig(composeConfig({ api: { ports: [{ host_ip: '127.0.0.1', published: '8083', target: 3000 }] } })), /below 10000/)
  assert.throws(() => inspectComposeConfig(composeConfig({ api: { ports: [{ host_ip: '127.0.0.1', published: '18080', target: 3000 }] } })), /Host port 18080 is published more than once/)
  assert.throws(() => inspectComposeConfig(composeConfig({ queue: { ports: [{ host_ip: '127.0.0.1', published: '18084', target: 3000 }] } })), /Queue HTTP/)
  assert.throws(() => inspectComposeConfig(composeConfig({ mailpit: { ports: [{ host_ip: '127.0.0.1', published: '11025', target: 1025 }] } })), /SMTP/)
})

test('requires every Dockerfile stage to use a complete Alpine patch and digest', () => {
  const valid = 'FROM alpine:3.24.4@sha256:' + 'a'.repeat(64) + '\nFROM alpine:3.24.4@sha256:' + 'b'.repeat(64) + ' AS runtime'
  assert.equal(assertPinnedAlpineDockerfiles({ 'Dockerfile': valid }), true)
  assert.throws(() => assertPinnedAlpineDockerfiles({ 'Dockerfile': 'FROM alpine:latest' }), /exact digest/)
  assert.throws(() => assertPinnedAlpineDockerfiles({ 'Dockerfile': `FROM alpine:3.24@sha256:${'a'.repeat(64)}` }), /complete patch/)
  assert.throws(() => assertPinnedAlpineDockerfiles({ 'Dockerfile': `FROM debian:12.1.0@sha256:${'a'.repeat(64)}` }), /Alpine base/)
  assert.throws(() => assertPinnedAlpineDockerfiles({ 'Dockerfile': 'RUN echo ok' }), /does not declare/)
})

test('requires a complete checksummed two-volume backup manifest', () => {
  const manifest = {
    format: 'executivepros-assessment-backup-v1',
    project: 'executivepros_assessment',
    created_at: '2026-11-14T00:00:00.000Z',
    source_volumes: { assessment_data: 'executivepros_assessment_assessment_data', mailpit_data: 'executivepros_assessment_mailpit_data' },
    source_volume_ids: { assessment_data: 'executivepros_assessment_assessment_data', mailpit_data: 'executivepros_assessment_mailpit_data' },
    image_ids: {},
    secret_fingerprints: Object.fromEntries(requiredSecrets.map((secret) => [secret, 'c'.repeat(64)])),
    archives: [
      { name: 'assessment_data.tar.gz', sha256: 'a'.repeat(64) },
      { name: 'mailpit_data.tar.gz', sha256: 'b'.repeat(64) },
    ],
  }
  assert.equal(validateBackupManifest(manifest), true)
  assert.throws(() => validateBackupManifest({ ...manifest, archives: manifest.archives.slice(0, 1) }), /both persistent/)
  assert.throws(() => validateBackupManifest({ ...manifest, archives: [{ name: '../data', sha256: 'c'.repeat(64) }] }), /unexpected archive/)
  assert.throws(() => validateBackupManifest({ ...manifest, archives: [{ ...manifest.archives[0], sha256: 'bad' }, manifest.archives[1]] }), /invalid checksum/)
})
