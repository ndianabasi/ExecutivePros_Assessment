import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = createApp({ isReady: () => true })

app.listen(config.port, '0.0.0.0', () => {
  process.stdout.write(`API listening on port ${config.port}\n`)
})
