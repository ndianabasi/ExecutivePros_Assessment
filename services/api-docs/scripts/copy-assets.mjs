import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)
const swaggerDir = dirname(require.resolve('swagger-ui-dist'))
const publicDir = resolve(root, 'public')
const output = resolve(root, 'build')

await rm(output, { recursive: true, force: true })
await mkdir(resolve(output, 'assets'), { recursive: true })
await cp(publicDir, output, { recursive: true })
for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js']) {
  await cp(resolve(swaggerDir, file), resolve(output, 'assets', file))
}
await cp(resolve(root, 'dist'), resolve(output, 'assets'), { recursive: true })
