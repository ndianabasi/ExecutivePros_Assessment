import { unlink } from 'node:fs/promises'

await unlink(new URL('../public/config.json', import.meta.url)).catch((error) => {
  if (error.code !== 'ENOENT') {
    throw error
  }
})
