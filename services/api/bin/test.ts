import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'

processCLIArgs(process.argv.splice(2))

configure({
  suites: [
    { name: 'unit', files: ['tests/unit/**/*.spec.ts'] },
    { name: 'integration', files: ['tests/integration/**/*.spec.ts'] },
    { name: 'contract', files: ['tests/contract/**/*.spec.ts'] },
    { name: 'e2e', files: ['tests/e2e/**/*.spec.ts'] },
  ],
  plugins: [assert()],
})

run()
