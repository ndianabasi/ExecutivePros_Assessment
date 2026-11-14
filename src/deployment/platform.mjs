import { posix, win32 } from 'node:path'

export function pathApiFor(platform = process.platform) {
  return platform === 'win32' ? win32 : posix
}

export function resolveRepositoryPath(repositoryRoot, value, platform = process.platform) {
  const paths = pathApiFor(platform)
  const absoluteRoot = paths.resolve(repositoryRoot)
  const absolutePath = paths.resolve(absoluteRoot, value)
  const relativePath = paths.relative(absoluteRoot, absolutePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${paths.sep}`) || paths.isAbsolute(relativePath)) {
    throw new Error('Path must name a file inside the repository')
  }
  return absolutePath
}

export function localSecretsDirectory(repositoryRoot, platform = process.platform) {
  return pathApiFor(platform).join(repositoryRoot, '.local', 'secrets')
}

export function secretPath(repositoryRoot, name, platform = process.platform) {
  return pathApiFor(platform).join(localSecretsDirectory(repositoryRoot, platform), name)
}
