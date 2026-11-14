import dotenv from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

process.env.NODE_ENV = 'test'
const path = [resolve(process.cwd(), '.env.test'), resolve(process.cwd(), '../../.env.test')].find(
  (candidate) => {
    return existsSync(candidate)
  },
)
if (path) {
  dotenv.config({ path })
}
