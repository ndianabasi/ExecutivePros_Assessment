export function assertDownMigrationAllowed(nodeEnv: string): void {
  if (!['development', 'test'].includes(nodeEnv)) {
    throw new Error('API down migrations are allowed only in development or test')
  }
}
