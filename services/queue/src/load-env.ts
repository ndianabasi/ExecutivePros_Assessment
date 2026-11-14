import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const file = process.env.NODE_ENV === 'test' ? '.env.test' : '.env'
const candidates = [resolve(process.cwd(), file), resolve(process.cwd(), '../../', file)]
const envPath = candidates.find((candidate) => {
  return existsSync(candidate)
})
if (envPath) {
  loadDotenv({ path: envPath })
}
