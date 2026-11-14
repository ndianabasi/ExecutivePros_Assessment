import dotenv from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const file = process.env.NODE_ENV === 'test' ? '.env.test' : '.env'
const path = [resolve(process.cwd(), file), resolve(process.cwd(), '../../', file)].find((candidate) => existsSync(candidate))
if (path) dotenv.config({ path })
