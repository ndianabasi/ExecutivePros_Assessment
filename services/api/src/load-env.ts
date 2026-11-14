import dotenv from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env'
const candidates = [resolve(process.cwd(), envFile), resolve(process.cwd(), '../../', envFile)]
const envPath = candidates.find((candidate) => {
  return existsSync(candidate)
})
if (envPath) {
  dotenv.config({ path: envPath })
}
