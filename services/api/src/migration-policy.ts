/**
 * Rejects database rollback commands outside the explicitly permitted test environment.
 *
 * @param nodeEnv - Runtime environment name used to select the permitted migration policy.
 */
export function assertDownMigrationAllowed(nodeEnv: string): void {
  if (!['development', 'test'].includes(nodeEnv)) {
    throw new Error('API down migrations are allowed only in development or test')
  }
}
