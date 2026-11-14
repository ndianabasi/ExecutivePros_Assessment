import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

process.env.NODE_ENV = 'test'
const candidates = [resolve(process.cwd(), '.env.test'), resolve(process.cwd(), '../../.env.test')]
const envPath = candidates.find((candidate) => existsSync(candidate))
if (envPath) loadDotenv({ path: envPath })
