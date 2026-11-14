#!/usr/bin/env node
import { Command } from 'commander'
import {
  backupDeployment,
  databaseDown,
  deployLocal,
  migrateUp,
  restoreDeployment,
  showStatus,
  stopDeployment,
  testAll,
} from '../src/deployment/manager.mjs'

const program = new Command()
  .name('assessment')
  .description('Safely deploy and operate the local ExecutivePros payment assessment stack')
  .showHelpAfterError()

program
  .command('deploy:local')
  .description('Preflight, build, migrate, start, and verify the local six-service stack')
  .option('--project <name>', 'Compose project name', 'executivepros_assessment')
  .option('--env-file <path>', 'Compose env file inside the repository', '.env')
  .option('--backup-directory <path>', 'Directory for cold upgrade backups', '.local/backups')
  .action(async (options) =>
    deployLocal({
      project: options.project,
      envFile: options.envFile,
      outputDirectory: options.backupDirectory,
    }),
  )

program
  .command('test:all')
  .description('Create a disposable test stack and run root plus every service test gate')
  .option('--env-file <path>', 'Test Compose environment file', '.env.test')
  .action(async (options) => testAll({ envFile: options.envFile }))

program
  .command('db:up')
  .description(
    'Build and run API, provider, and queue database initialization without starting regular services',
  )
  .option('--project <name>', 'Compose project name', 'executivepros_assessment')
  .option('--env-file <path>', 'Compose env file inside the repository', '.env')
  .action(async (options) => migrateUp({ project: options.project, envFile: options.envFile }))

program
  .command('db:down')
  .description('Delete persistent volumes only for a specifically confirmed disposable Compose project')
  .requiredOption('--project <name>', 'Disposable Compose project name')
  .requiredOption('--confirm-project <name>', 'Must exactly match --project')
  .option('--env-file <path>', 'Compose env file inside the repository', '.env')
  .action(async (options) =>
    databaseDown({
      project: options.project,
      confirmProject: options.confirmProject,
      envFile: options.envFile,
    }),
  )

program
  .command('backup')
  .description('Stop writers and create a verified cold backup of both project volumes')
  .option('--project <name>', 'Compose project name', 'executivepros_assessment')
  .option('--env-file <path>', 'Compose env file inside the repository', '.env')
  .option('--output-directory <path>', 'Backup output directory', '.local/backups')
  .action(async (options) =>
    backupDeployment({
      project: options.project,
      envFile: options.envFile,
      outputDirectory: options.outputDirectory,
    }),
  )

program
  .command('restore <backup-directory>')
  .description('Restore a verified backup into new volumes for an explicitly confirmed disposable project')
  .requiredOption('--project <name>', 'New disposable Compose project name')
  .requiredOption('--confirm-project <name>', 'Must exactly match --project')
  .option('--env-file <path>', 'Compose env file inside the repository', '.env')
  .action(async (backupDirectory, options) =>
    restoreDeployment({
      backupDirectory,
      project: options.project,
      confirmProject: options.confirmProject,
      envFile: options.envFile,
    }),
  )

program
  .command('status')
  .description('Show service status without changing project data')
  .option('--project <name>', 'Compose project name', 'executivepros_assessment')
  .option('--env-file <path>', 'Compose env file inside the repository', '.env')
  .action(async (options) => showStatus({ project: options.project, envFile: options.envFile }))

program
  .command('stop')
  .description('Stop regular services while preserving project volumes')
  .option('--project <name>', 'Compose project name', 'executivepros_assessment')
  .option('--env-file <path>', 'Compose env file inside the repository', '.env')
  .action(async (options) => stopDeployment({ project: options.project, envFile: options.envFile }))

try {
  await program.parseAsync(process.argv)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`assessment: ${message}\n`)
  process.exitCode = 1
}
